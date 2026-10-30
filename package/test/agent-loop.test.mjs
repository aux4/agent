import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  parseJSONLoose,
  WORKING_RULES,
  findCommands,
  lookupQueries,
  enteredValues,
  unsourcedValues,
  unsourcedFieldValues,
  fieldEvidenceText,
  availableFieldChoices,
  applyProvenance,
  applyExecutionProof,
  executionProofContent,
  activeDelegations,
  delegatedDenyPatterns,
  addDenyPatterns,
  describeFoundCommands,
  preferredDelegation,
  executionCommandReference,
  extractAttemptLog,
  changeDenyPatterns,
  summarizeAttemptLog,
  mergeDenyPolicy,
  sameFailureShape,
  extractFailureClass,
  isBlocked,
  sameReadEvidence,
  sameReadFacts,
  hasNewReadSource,
  isChangeCommand,
  isBudgetExceededResult,
  runAux4Monitored,
  composeDiagnoseQuestion,
  composeEvidenceSummary,
  composeScopedContinuationQuestion,
  freshScopedContinuation,
  freshScopedReadAttempt,
  composeExecuteQuestion,
  incompleteNote,
  fallbackPlan,
  fallbackVerdict,
  runLoop,
  runVerify,
  requireOwnObservation,
  verifyPayload,
  salvageVerdict,
  stripFailureClass,
  COVERAGE_CRITERION,
  HONESTY_CRITERION,
  AGREEMENT_CRITERION,
  PROVENANCE_CRITERION,
  verifyCriteria,
  allowedCommandsOffered,
  unresolvedActionGuard,
  readBackCandidates,
  askedWithoutLooking,
  describedWithoutDoing,
  missingParameterHints,
  isSafeReadBack,
  isReadCommand,
  pickFromReply,
  pickReadBack,
  capRetryBudget,
  dropTrailingTextCall,
  onlyAnswerFailed,
  isConclusiveAttempt,
  historyStats,
  metricsPath,
  readVerdict,
  verdictLogPath,
  RETRY_BUDGET,
  runReadBack,
  isNoChangeCriterion,
  unverifiableOnlyAfterChange,
  commandWords,
  pendingConfirmation,
  isClearlyRequestedAction,
  compactResult,
  composeRunNextQuestion,
  composeNeedsConfirmationAnswer
} from "../lib/agent-loop.mjs";
import { scopedContinuationGuardMessage } from "../lib/check-values.mjs";

function tmpFile(name, content) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-test-"));
  const file = path.join(folder, name);
  fs.writeFileSync(file, content);
  return file;
}

function makeFakeAux4(body) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-fake-"));
  const fake = path.join(folder, "aux4-fake");
  fs.writeFileSync(fake, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return fake;
}

function baseOptions(overrides = {}) {
  return {
    request: "do the thing",
    configFile: "config.yaml",
    config: "",
    packageDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    permissions: "",
    policy: '{"budget":{"calls":60}}',
    ...overrides
  };
}

// --- parseJSONLoose ---------------------------------------------------------

test("parseJSONLoose parses clean JSON", () => {
  assert.deepEqual(parseJSONLoose('{"a":1}', null), { a: 1 });
});

test("explicit page tasks get registered capability help before global command search", async () => {
  const delegate = { via: 'agent:forms', urlTasks: true, requestWords: ['page', 'form'], entrypoints: ['run', 'find'] };
  const request = 'On the settings page at https://example.test/settings, change the telephone only.';
  assert.equal(preferredDelegation(request, [delegate]), delegate);
  assert.equal(preferredDelegation('POST the form payload to the endpoint https://example.test/api', [delegate]), null);
  assert.equal(preferredDelegation('Update a record using the installed CLI', [delegate]), null);
  const urlDelegate = { ...delegate, requestWords: [] };
  assert.equal(preferredDelegation('Change the telephone for the named record at https://example.test/records', [urlDelegate]), urlDelegate);
  assert.equal(preferredDelegation('Fetch JSON from https://example.test/records', [urlDelegate]), null);
  const fake = makeFakeAux4(`
const args = process.argv.slice(2);
if (args.includes('pkger')) process.exit(1);
if (args.includes('run')) process.stdout.write('run\\n  --url <page>\\n  --goal <outcome>');
if (args.includes('find')) process.stdout.write('find\\n  --question <question>');
`);
  await withAux4Bin(fake, async () => {
    const reference = executionCommandReference(request, {}, [delegate]);
    assert.match(reference, /agent forms run/);
    assert.match(reference, /--goal <outcome>/);
    assert.match(reference, /pass the complete requested outcome, supplied values, and exclusions/);
    assert.match(reference, /Authorization does not replace required data/);
    assert.match(reference, /agent forms find/);
  });
});

test("parseJSONLoose strips a markdown code fence", () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```', null), { a: 1 });
});

test("parseJSONLoose extracts the first balanced JSON object out of prose", () => {
  const text = 'Sure, here you go:\n{"a":1,"b":[1,2]}\nHope that helps!';
  assert.deepEqual(parseJSONLoose(text, null), { a: 1, b: [1, 2] });
});

test("parseJSONLoose falls back on unusable input", () => {
  assert.equal(parseJSONLoose("not json at all", "FALLBACK"), "FALLBACK");
  assert.equal(parseJSONLoose("", "FALLBACK"), "FALLBACK");
  assert.equal(parseJSONLoose(null, "FALLBACK"), "FALLBACK");
});

// --- attempt log -------------------------------------------------------------

function historyFixture() {
  const messages = [
    {
      role: "assistant_with_tool",
      content: {
        tool_calls: [
          { id: "call-1", name: "executeAux4", args: { command: "todo list" } },
          { id: "call-2", name: "executeAux4", args: { command: "todo complete --id 9" } }
        ]
      }
    },
    { role: "tool", tool_call_id: "call-1", name: "executeAux4", content: "1. buy milk" },
    { role: "tool", tool_call_id: "call-2", name: "executeAux4", content: "Error: no such item 9" },
    { role: "assistant", content: "Done." }
  ];
  return tmpFile("history.json", JSON.stringify({ messages, tokenUsage: {} }));
}

test("extractAttemptLog pairs tool calls with their results and flags failures", () => {
  const file = historyFixture();
  const attempts = extractAttemptLog(file);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].command, "todo list");
  assert.equal(attempts[0].failed, false);
  assert.equal(attempts[0].completed, true);
  assert.equal(attempts[1].command, "todo complete --id 9");
  assert.equal(attempts[1].failed, true);
  assert.match(attempts[1].resultSummary, /no such item/);
});

test("extractAttemptLog distinguishes a pending write from a completed action", () => {
  const file = tmpFile("pending.json", JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "pending", name: "executeAux4", args: { command: "records delete --id r-1" } }] } }
  ] }));
  const [pending] = extractAttemptLog(file);
  assert.equal(pending.completed, false);
});

test("an unsubmitted form and a pending call are not completed action evidence", () => {
  assert.equal(isConclusiveAttempt({ source: '{"status":"done","submitted":false}' }), false);
  assert.equal(isConclusiveAttempt({ source: '{"status":"done","submitted":true}' }), true);
  assert.equal(isConclusiveAttempt({ completed: false, source: '' }), false);
});

test("extractAttemptLog is defensive about a missing or malformed file", () => {
  assert.deepEqual(extractAttemptLog(""), []);
  assert.deepEqual(extractAttemptLog("/no/such/file.json"), []);
  const bad = tmpFile("bad.json", "not json");
  assert.deepEqual(extractAttemptLog(bad), []);
});

test("summarizeAttemptLog renders a readable ordered list, and a placeholder when empty", () => {
  const file = historyFixture();
  const summary = summarizeAttemptLog(extractAttemptLog(file));
  assert.match(summary, /1\. todo list -> ok:/);
  assert.match(summary, /2\. todo complete --id 9 -> FAILED:/);
  assert.equal(summarizeAttemptLog([]), "(no actions were taken)");
});

// --- deny policy -------------------------------------------------------------

test("mergeDenyPolicy adds a deny entry for failed commands without touching the budget", () => {
  const merged = JSON.parse(mergeDenyPolicy('{"budget":{"calls":60}}', ["todo complete --id 9"]));
  assert.deepEqual(merged.budget, { calls: 60 });
  assert.deepEqual(merged.deny, [{ executeAux4: ["todo complete --id 9"] }]);
});

test("mergeDenyPolicy is a no-op when there is nothing new to deny", () => {
  const original = '{"budget":{"calls":60}}';
  assert.deepEqual(JSON.parse(mergeDenyPolicy(original, [])), JSON.parse(original));
});

test("mergeDenyPolicy does not duplicate a command already denied", () => {
  const policy = JSON.stringify({ deny: [{ executeAux4: ["todo complete --id 9"] }] });
  const merged = JSON.parse(mergeDenyPolicy(policy, ["todo complete --id 9", "todo complete --id 9"]));
  assert.equal(merged.deny.length, 1);
  assert.deepEqual(merged.deny[0].executeAux4, ["todo complete --id 9"]);
});

// --- stop-condition helpers --------------------------------------------------

test("sameFailureShape compares unmet criteria, ignoring evidence wording and fail/unverifiable drift", () => {
  const a = { criteria: [{ criterion: "x", status: "fail", evidence: "tried A" }] };
  const b = { criteria: [{ criterion: "x", status: "fail", evidence: "tried B, differently" }] };
  assert.equal(sameFailureShape(a, b), true);
  assert.equal(sameFailureShape(a, { criteria: [{ criterion: "x", status: "unverifiable", evidence: "same evidence" }] }), true);
  assert.equal(sameFailureShape(a, { criteria: [{ criterion: "x", status: "pass", evidence: "newly verified" }] }), false);
});

test("sameFailureShape is false when the failing criterion changes", () => {
  const a = { criteria: [{ criterion: "x", status: "fail", evidence: "" }] };
  const b = { criteria: [{ criterion: "y", status: "fail", evidence: "" }] };
  assert.equal(sameFailureShape(a, b), false);
});

test("sameFailureShape is false with no prior verdict", () => {
  assert.equal(sameFailureShape(null, { criteria: [] }), false);
});

test("extractFailureClass / isBlocked recognize the classification line", () => {
  assert.equal(extractFailureClass("FAILURE_CLASS: wrong_tool\nrest"), "wrong_tool");
  assert.equal(extractFailureClass("failure_class: blocked"), "blocked");
  assert.equal(extractFailureClass("no classification here"), "");
  assert.equal(isBlocked("FAILURE_CLASS: blocked\nI need your account password."), true);
  assert.equal(isBlocked("FAILURE_CLASS: incomplete\nstill working"), false);
});

test("composeDiagnoseQuestion lists only the unmet criteria and asks for action, not a classification", () => {
  const plan = { goal: "ship it", doneCriteria: ["a", "b"], steps: [] };
  const verdict = {
    overall: "fail",
    criteria: [{ criterion: "a", status: "pass", evidence: "" }, { criterion: "b", status: "fail", evidence: "saw no change" }]
  };
  const q = composeDiagnoseQuestion(plan, verdict, []);
  assert.doesNotMatch(q, /- a \(pass\)/);
  assert.match(q, /- b \(fail\): saw no change/);
  assert.match(q, /fix it now by calling the tools/);
  assert.match(q, /BLOCKED:/);
});

test("composeExecuteQuestion states every done-criterion and appends recovery context when given", () => {
  const plan = { goal: "g", doneCriteria: ["x holds", "y holds"], steps: ["look at z first"] };
  const q = composeExecuteQuestion("do the thing", plan, "");
  assert.match(q, /- x holds/);
  assert.match(q, /- y holds/);
  assert.match(q, /look at z first/);
  const withRecovery = composeExecuteQuestion("do the thing", plan, "it blew up");
  assert.match(withRecovery, /it blew up/);
});

test("incompleteNote reports only the unmet criteria", () => {
  const verdict = { criteria: [{ criterion: "a", status: "pass", evidence: "" }, { criterion: "b", status: "unverifiable", evidence: "couldn't check" }] };
  const note = incompleteNote(verdict);
  assert.doesNotMatch(note, /- a:/);
  assert.match(note, /- b: unverifiable \(couldn't check\)/);
});

test("fallbackPlan and fallbackVerdict never claim a pass", () => {
  const plan = fallbackPlan("do the thing");
  assert.equal(plan.goal, "do the thing");
  assert.ok(plan.doneCriteria.length > 0);
  const verdict = fallbackVerdict(plan.doneCriteria, "no verifier available");
  assert.equal(verdict.overall, "fail");
  assert.ok(verdict.criteria.every(c => c.status === "unverifiable"));
});

// --- runLoop end-to-end (plan/verify via a scripted fake aux4; execute stubbed) ---

function planVerifyFake({ verifyStatus = "pass", verifierObserves = true } = {}) {
  return makeFakeAux4(`
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.join(" ");
if (command.includes("loop-plan.md")) {
  process.stdout.write(JSON.stringify({ goal: "g", doneCriteria: ["the outcome holds"], steps: [] }));
} else if (command.includes("loop-verify.md")) {
  const historyAt = args.indexOf("--history");
  if (${verifierObserves} && historyAt >= 0) {
    const messages = [
      { role: "assistant_with_tool", content: { tool_calls: [{ id: "v1", name: "executeAux4", args: { command: "read the current state" } }] } },
      { role: "tool", tool_call_id: "v1", name: "executeAux4", content: "state" }
    ];
    fs.writeFileSync(args[historyAt + 1], JSON.stringify({ messages }));
  }
  const question = args[args.indexOf("--question") + 1] || "";
  const payload = JSON.parse(question.slice(question.indexOf("{")));
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => ({ criterion: c.criterion, status: "${verifyStatus}", evidence: "checked" })) }));
}
`);
}

function statusSequenceFake(statuses) {
  return makeFakeAux4(`
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.join(" ");
if (command.includes("loop-plan.md")) {
  process.stdout.write(JSON.stringify({ goal: "g", doneCriteria: ["the outcome holds"], steps: [] }));
} else if (command.includes("loop-verify.md")) {
  const historyAt = args.indexOf("--history");
  const verifyHistory = args[historyAt + 1];
  const messages = [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "v1", name: "executeAux4", args: { command: "read the current state" } }] } },
    { role: "tool", tool_call_id: "v1", name: "executeAux4", content: "current state observed" }
  ];
  fs.writeFileSync(verifyHistory, JSON.stringify({ messages }));
  const match = verifyHistory.match(/\\.verify-(\\d+)\\.json$/);
  const round = match ? Number(match[1]) : 1;
  const statuses = ${JSON.stringify(statuses)};
  const status = statuses[Math.min(round - 1, statuses.length - 1)];
  const question = args[args.indexOf("--question") + 1] || "";
  const payload = JSON.parse(question.slice(question.indexOf("{")));
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => ({ criterion: c.criterion, status, evidence: "same unmet outcome" })) }));
}
`);
}

function appendExecutionResult(history, command, source, id) {
  const data = JSON.parse(fs.readFileSync(history, "utf8"));
  data.messages.push(
    { role: "assistant_with_tool", content: { tool_calls: [{ id, name: "executeAux4", args: { command } }] } },
    { role: "tool", tool_call_id: id, name: "executeAux4", content: source }
  );
  fs.writeFileSync(history, JSON.stringify(data));
}

async function withAux4Bin(fake, fn) {
  const prior = process.env.AUX4_BIN;
  process.env.AUX4_BIN = fake;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.AUX4_BIN;
    else process.env.AUX4_BIN = prior;
  }
}

test("runLoop stops on the first attempt when the verifier passes", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions(), history, () => { calls++; return "the answer"; });
    assert.equal(outcome.stopped, "pass");
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.content, "the answer");
    assert.equal(calls, 1);
  });
});

test("runLoop exhausts the retry budget and reports what remained unmet", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = historyFixture();
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const deniedSeen = [];
    const outcome = await runLoop(baseOptions(), history, (question, h, denied) => {
      calls++;
      deniedSeen.push([...denied]);
      return `attempt ${calls}`;
    });
    assert.equal(outcome.stopped, "no-progress");
    // Same fixture attempt log every time -> same failure shape -> stop after the
    // first retry confirms no progress, rather than burning the whole budget.
    assert.equal(outcome.attempts, 2);
    assert.match(outcome.content, /Not fully confirmed/);
    assert.ok(calls <= RETRY_BUDGET + 1);
    // the failing command from the fixture is denied starting with the retry
    assert.deepEqual(deniedSeen[0], []);
    assert.ok(deniedSeen[1].includes("todo complete --id 9"));
  });
});

test("runLoop recovers after an inner repeated-result stop instead of ending the task", async () => {
  const verifyCounter = tmpFile("verify-count.txt", "0");
  const fake = makeFakeAux4(`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.some(a => a.endsWith('loop-plan.md'))) {
  process.stdout.write(JSON.stringify({ goal: 'g', doneCriteria: [{ text: 'the answer says done', kind: 'answer' }] }));
} else if (args.some(a => a.endsWith('loop-verify.md'))) {
  const n = Number(fs.readFileSync(${JSON.stringify(verifyCounter)}, 'utf8')) + 1;
  fs.writeFileSync(${JSON.stringify(verifyCounter)}, String(n));
  const question = args[args.indexOf('--question') + 1] || '';
  const payload = JSON.parse(question.slice(question.indexOf('{')));
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => ({
    criterion: c.criterion,
    status: c.criterion === 'the answer says done' && n === 1 ? 'fail' : 'pass',
    evidence: 'checked'
  })) }));
}
`);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const questions = [];
    let calls = 0;
    const addAttempt = (messages, id, command, result) => {
      messages.push({ role: "assistant_with_tool", content: { tool_calls: [{ id, name: "executeAux4", args: { command } }] } });
      messages.push({ role: "tool", tool_call_id: id, name: "executeAux4", content: result });
    };
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      calls++;
      questions.push(question);
      const data = JSON.parse(fs.readFileSync(h, "utf8"));
      if (calls === 1) {
        const command = "agent browser find --url https://example.test --question 'find the item'";
        for (let i = 0; i < 3; i++) addAttempt(data.messages, `repeat-${i}`, command, "same empty result");
        fs.writeFileSync(h, JSON.stringify(data));
        return { content: "Stopped after repeated results.", stopReason: "no-progress" };
      }
      addAttempt(data.messages, "alternate", "agent browser find --url https://example.test --question 'inspect the visible form'", "new page evidence");
      fs.writeFileSync(h, JSON.stringify(data));
      return "done";
    });
    assert.equal(outcome.stopped, "pass");
    assert.equal(outcome.attempts, 2);
    assert.match(questions[1], /materially different action or evidence source/);
  });
});

test("runLoop sends target-aware denials for a successful change into the next execution round", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const command = 'google calendar events create --summary "Vendor sync meeting" --start "2026-03-20T10:00:00Z" --end "2026-03-20T10:30:00Z"';
  const history = tmpFile("history.json", JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "change-1", name: "executeAux4", args: { command } }] } },
    { role: "tool", tool_call_id: "change-1", name: "executeAux4", content: '{"kind":"calendar#event","status":"confirmed"}' }
  ], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const received = [];
    await runLoop(baseOptions(), history, (_question, _history, _denied, _retry, patterns) => {
      received.push(patterns || []);
      return "attempt did not finish the remaining criterion";
    });
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], []);
    assert.ok(received[1].length > 0);
    assert.ok(received[1].some(pattern => pattern.includes("Vendor sync meeting")));
  });
});

test("runLoop stops on a blocked retry without leaking its unsupported completion claim", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions(), history, () => {
      calls++;
      return calls === 1 ? "first attempt text" : "FAILURE_CLASS: blocked\nThe requested task is complete. I need the requester's approval.";
    });
    assert.equal(outcome.stopped, "blocked");
    assert.equal(outcome.attempts, 2);
    assert.match(outcome.content, /Not fully confirmed/);
    assert.doesNotMatch(outcome.content, /requested task is complete|requester's approval/);
  });
});

test("a pre-action evidence denial gets one same-round lookup recovery before declaring blocked", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      calls++;
      if (calls === 1) {
        fs.writeFileSync(h, JSON.stringify({ messages: [
          { role: "assistant_with_tool", content: { tool_calls: [{ id: "denied", name: "executeAux4", args: { command: "notifications send --to unknown@work.test" } }] } },
          { role: "tool", tool_call_id: "denied", content: "Blocked by hook: ACTION_CHECK_EVIDENCE_REQUIRED: obtain the exact destination first" }
        ] }));
        return "I cannot send the message. Please provide the destination.";
      }
      assert.match(question, /obtain the missing evidence/);
      return "done";
    });
    assert.equal(calls, 2);
    assert.equal(outcome.stopped, "pass");
    assert.equal(outcome.attempts, 1);
  });
});

// --- verifier must observe for itself -----------------------------------------

test("verifyPayload gives the request verbatim, typed criteria plus coverage, and raw results", () => {
  const plan = { goal: "g", doneCriteria: ["the item is gone", "the reply names it"], stateCriteria: ["the item is gone"] };
  const payload = verifyPayload(plan, "answer", [
    { command: "todo list", failed: false, result: "1. buy milk" },
    { command: "todo complete --id 9", failed: true, result: "Error: no such item 9" }
  ], "remove item 9 and tell me which it was");
  assert.equal(payload.request, "remove item 9 and tell me which it was");
  assert.deepEqual(payload.criteria.map(c => c.kind), ["state", "answer", "answer", "answer", "answer"]);
  assert.equal(payload.criteria[2].criterion, COVERAGE_CRITERION);
  assert.equal(payload.criteria[3].criterion, HONESTY_CRITERION);
  assert.equal(payload.criteria[4].criterion, AGREEMENT_CRITERION);
  assert.deepEqual(payload.actions.map(a => a.result), ["1. buy milk", "Error: no such item 9"]);
});

test("verification retains concrete page observations and control states within its total budget", () => {
  const source = JSON.stringify({ goal: 'requested outcome '.repeat(500), timing: { total: 99 },
    observations: { firstObserved: 'Ari | Oslo | 555-0100; Robin | Bern | 555-0200', current: 'Ari | Oslo | 555-0107; Robin | Bern | 555-0200' },
    lastFormControlStates: { url: 'https://example.test/settings', controls: ['Security (checkbox): checked','Marketing (checkbox): unchecked'] },
    submitted: true, status: 'done' });
  const plan = { goal:'update the phone', doneCriteria:['phone changed'], stateCriteria:['phone changed'] };
  const payload = verifyPayload(plan, 'updated', [{ command:'agent forms run', source, result:'truncated earlier' }]);
  assert.match(payload.actions[0].result, /555-0100/);
  assert.match(payload.actions[0].result, /555-0107/);
  assert.match(payload.actions[0].result, /Marketing \(checkbox\): unchecked/);
  assert.match(compactResult(source,800), /"submitted":true/);
  const many = verifyPayload(plan,'updated',Array.from({length:10},()=>({ command:'lookup',source })));
  assert.ok(many.actions.reduce((total,action)=>total+action.result.length,0)<=4000);
});

test("verifyCriteria appends coverage, honesty, and agreement after the plan's own criteria", () => {
  const plan = { doneCriteria: ["a", "b"] };
  assert.deepEqual(verifyCriteria(plan), ["a", "b", COVERAGE_CRITERION, HONESTY_CRITERION, AGREEMENT_CRITERION]);
});

test("salvageVerdict recovers complete entries from a reply cut off mid-JSON", () => {
  const cut = '{"results":[{"criterion":"a","status":"pass","evidence":"saw it"},{"criterion":"b","status":"fail","evidence":"the list still sho';
  const out = salvageVerdict(cut);
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0], { criterion: "a", status: "pass", evidence: "saw it" });
  assert.equal(out.results[1].status, "fail");
  assert.equal(salvageVerdict("no json here"), null);
});

test("stripFailureClass removes the harness label from the answer", () => {
  assert.equal(stripFailureClass("FAILURE_CLASS: tool_error\nThe event moved to 16:00."), "The event moved to 16:00.");
});

test("mergeDenyPolicy never adds a failed command that contains a glob", () => {
  const out = JSON.parse(mergeDenyPolicy('{"budget":{"calls":5}}', ["list *", "get --id 1"]));
  assert.deepEqual(out.deny, [{ executeAux4: ["get --id 1"] }]);
});

test("changeDenyPatterns covers the same target when cosmetic fields and flag order change", () => {
  const original = 'google calendar events create --summary "Vendor sync meeting" --start "2026-03-20T10:00:00Z" --end "2026-03-20T10:30:00Z"';
  const repeated = 'google calendar events create --calendarId primary --description "Unique description 123" --end "2026-03-20T10:45:00Z" --start "2026-03-20T10:00:00Z" --summary "Vendor sync meeting"';
  const differentTarget = repeated.replace("Vendor sync meeting", "Another meeting");
  const patterns = changeDenyPatterns(original);
  const matches = command => patterns.some(pattern => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(command);
  });

  assert.ok(patterns.length > 0);
  assert.equal(matches(repeated), true);
  assert.equal(matches(differentTarget), false);
});

test("changeDenyPatterns preserves mixed-case entity flags for the same target", () => {
  const original = 'google calendar events update --eventId evt-123 --start "2026-03-20T10:00:00Z"';
  const patterns = changeDenyPatterns(original);
  assert.ok(patterns.some(pattern => pattern.includes("--eventId") && pattern.includes("evt-123")));
});

test("target patterns are admitted only through the dedicated generated-pattern argument", () => {
  const raw = '{"budget":{"calls":5}}';
  const generated = 'google calendar events create *--summary*"Vendor sync meeting"*';
  assert.deepEqual(JSON.parse(mergeDenyPolicy(raw, ["list *"])), { budget: { calls: 5 }, deny: [] });
  assert.deepEqual(JSON.parse(mergeDenyPolicy(raw, [], [generated])).deny, [{ executeAux4: [generated] }]);
});

test("requireOwnObservation downgrades unobserved passes on state criteria only", () => {
  const verdict = { overall: "pass", criteria: [
    { criterion: "the item is gone", status: "pass", evidence: "the log says so" },
    { criterion: "the reply names it", status: "pass", evidence: "it does" }
  ] };
  const out = requireOwnObservation(verdict, [], ["the item is gone"]);
  const failed = requireOwnObservation({ overall: "fail", criteria: [{ criterion: "the item is gone", status: "fail", evidence: "old list shows it" }] }, [], ["the item is gone"]);
  assert.equal(failed.criteria[0].status, "unverifiable");
  assert.equal(out.overall, "fail");
  assert.equal(out.criteria[0].status, "unverifiable");
  assert.match(out.criteria[0].evidence, /no checks of its own/);
  assert.equal(out.criteria[1].status, "pass");
  assert.deepEqual(requireOwnObservation(verdict, [{ command: "read" }], ["the item is gone"]), verdict);
});

test("runLoop does not accept a pass the verifier never observed", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass", verifierObserves: false });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, () => "the answer");
    assert.notEqual(outcome.stopped, "pass");
    assert.equal(outcome.verdict.criteria[0].status, "unverifiable");
  });
});

test("runLoop keeps every verify round, with the verifier's own checks, next to the plan", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    await runLoop(baseOptions(), history, () => "the answer");
    const rounds = JSON.parse(fs.readFileSync(verdictLogPath(history), "utf8"));
    assert.ok(rounds.length >= 2);
    assert.equal(rounds[0].attempt, 1);
    assert.deepEqual(rounds[0].checks, ["read the current state"]);
    assert.equal(rounds[0].criteria[0].status, "fail");
  });
});

test("runLoop stops without retrying when the requester declines to confirm an action", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      calls++;
      fs.writeFileSync(h, JSON.stringify({ messages: [
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: "remove item 3" } }] } },
        { role: "tool", tool_call_id: "c1", content: "User aborted" }
      ] }));
      return "I could not remove it: the confirmation was declined.";
    });
    assert.equal(outcome.stopped, "declined");
    assert.equal(calls, 1);
  });
});

test("runLoop never returns the failure-class label to the requester", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, () => "FAILURE_CLASS: incomplete\nDone now.");
    assert.equal(outcome.content, "Done now.");
  });
});

test("a verdict whose criteria were reworded is matched by position", async () => {
  const fake = makeFakeAux4(`
const args = process.argv.slice(2);
const command = args.join(" ");
if (command.includes("loop-plan.md")) process.stdout.write(JSON.stringify({ goal: "g", doneCriteria: [{ text: "the reply names the item", kind: "answer" }], steps: [] }));
else if (command.includes("loop-verify.md")) process.stdout.write(JSON.stringify({ results: [{ criterion: "Reply names item.", status: "pass", evidence: "it does" }, { criterion: "covers all", status: "pass", evidence: "yes" }, { criterion: "honest", status: "pass", evidence: "matches" }, { criterion: "agrees", status: "pass", evidence: "matches" }] }));
`);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, () => "the item is X");
    assert.equal(outcome.stopped, "pass");
    assert.equal(outcome.verdict.criteria[0].criterion, "the reply names the item");
  });
});

test("a verdict cut off mid-JSON is salvaged rather than read as one inner entry", async () => {
  const fake = makeFakeAux4(`
const args = process.argv.slice(2);
const command = args.join(" ");
if (command.includes("loop-plan.md")) process.stdout.write(JSON.stringify({ goal: "g", doneCriteria: [{ text: "a", kind: "answer" }, { text: "b", kind: "answer" }], steps: [] }));
else if (command.includes("loop-verify.md")) process.stdout.write('\`\`\`json\\n{"results":[{"criterion":"a","status":"pass","evidence":"ok"},{"criterion":"b","status":"fail","evidence":"no"},{"criterion":"c","sta');
`);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, () => "answer");
    assert.equal(outcome.verdict.criteria[0].status, "pass");
    assert.equal(outcome.verdict.criteria[1].status, "fail");
  });
});

test("allowedCommandsOffered reads the list from the latest permission message", () => {
  const attempts = [
    { command: "x", result: "ok" },
    { command: "y", result: 'Permission denied: command "y" is not allowed by the permissions configuration. Commands you may run: aux4 a list, aux4 b get. Use one of these instead' }
  ];
  assert.equal(allowedCommandsOffered(attempts), "aux4 a list, aux4 b get");
  assert.equal(allowedCommandsOffered([{ command: "x", result: "ok" }]), "");
});

test("readVerdict only accepts a parse that carries results", () => {
  assert.equal(readVerdict('{"criterion":"a","status":"pass"}').results.length, 1);
  assert.equal(readVerdict("the task is complete"), null);
});

test("runLoop pushes once past a 'blocked' claim when allowed commands were offered", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const questions = [];
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      questions.push(question);
      if (questions.length === 1) {
        fs.writeFileSync(h, JSON.stringify({ messages: [
          { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: "guess" } }] } },
          { role: "tool", tool_call_id: "c1", content: "Permission denied: nope. Commands you may run: aux4 real list." }
        ] }));
        return "FAILURE_CLASS: blocked\nI need access.";
      }
      return "Here it is.";
    });
    assert.equal(questions.length, 2);
    assert.match(questions[1], /aux4 real list/);
    assert.equal(outcome.stopped, "pass");
  });
});

test("historyStats counts model calls, tokens, and calls that bought nothing", () => {
  const usage = (i, o) => ({ kwargs: { response_metadata: { tokenUsage: { promptTokens: i, completionTokens: o }, usage: { prompt_tokens_details: { cached_tokens: i - 10 } } } } });
  const file = tmpFile("history.json", JSON.stringify({ messages: [
    { role: "user", content: "do it" },
    { role: "assistant_with_tool", content: { ...usage(100, 20), tool_calls: [{ id: "a", name: "executeAux4", args: { command: "x --help" } }] } },
    { role: "tool", tool_call_id: "a", content: "help text" },
    { role: "assistant_with_tool", content: { ...usage(150, 30), tool_calls: [{ id: "b", name: "executeAux4", args: { command: "x list" } }] } },
    { role: "tool", tool_call_id: "b", content: "Error: nope" },
    { role: "user", content: "You returned nothing. Look at the last tool result" },
    { role: "assistant_with_tool", content: { ...usage(200, 10), tool_calls: [{ id: "c", name: "executeAux4", args: { command: "x list" } }] } },
    { role: "tool", tool_call_id: "c", content: "ok" },
    { role: "assistant", content: { ...usage(220, 15), content: "done" } }
  ] }));
  const s = historyStats(file);
  assert.deepEqual(s, { modelCalls: 5, input: 670, cached: 630, output: 75, toolCalls: 3, failed: 1, repeats: 1, help: 1, emptyReplies: 1 });
  assert.equal(historyStats(file, 5).modelCalls, 3);
});

test("runLoop saves per-phase metrics next to the plan", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, () => "answer");
    const saved = JSON.parse(fs.readFileSync(metricsPath(history), "utf8"));
    assert.equal(saved.stopped, "pass");
    assert.equal(saved.rounds.length, 1);
    assert.ok("verify" in saved.rounds[0] && "total" in saved);
    assert.equal(outcome.metrics.stopped, "pass");
  });
});

test("historyStats prefers the history's own tokenUsage, minus what was spent before", () => {
  const file = tmpFile("history.json", JSON.stringify({ tokenUsage: { input: 900, cached: 600, output: 120 }, messages: [
    { role: "user", content: "q" }, { role: "assistant", content: "a" }
  ] }));
  const s = historyStats(file, 0, { input: 400, cached: 300, output: 20 });
  assert.equal(s.modelCalls, 1);
  assert.deepEqual([s.input, s.cached, s.output], [500, 300, 100]);
});

test("readBackCandidates offers the commands that worked, without help or repeats", () => {
  const out = readBackCandidates([
    { tool: "executeAux4", command: "x list --help", failed: false },
    { tool: "executeAux4", command: "x list", failed: false },
    { tool: "executeAux4", command: "x get 1", failed: true },
    { tool: "currentDateTime", command: "currentDateTime {}", failed: false },
    { tool: "executeAux4", command: "x list", failed: false },
    { tool: "executeAux4", command: "x delete 1", failed: false }
  ]);
  assert.deepEqual(out, ["x list", "x delete 1"]);
});

test("askedWithoutLooking spots a question asked with no tool call", () => {
  assert.equal(askedWithoutLooking("What is the date?", 0), true);
  assert.equal(askedWithoutLooking("FAILURE_CLASS: incomplete\nWhich one?", 0), true);
  assert.equal(askedWithoutLooking("What is the date?", 2), false);
  assert.equal(askedWithoutLooking("Done.", 0), false);
});

test("describedWithoutDoing spots a retry that only narrated its next step", () => {
  assert.equal(describedWithoutDoing("I will send the reply with gmail send.", 0), true);
  assert.equal(describedWithoutDoing("I will send the reply.", 1), false);
  assert.equal(describedWithoutDoing("The meeting was moved.", 0), false);
  assert.equal(describedWithoutDoing('executeAux4("aux4 ai skill list")', 0), true);
});

test("isBlocked accepts the BLOCKED: mark, and the answer drops it", async () => {
  assert.equal(isBlocked("BLOCKED: I need the account password."), true);
  assert.equal(stripFailureClass("BLOCKED: I need the account password."), "I need the account password.");
});

test("isBlocked recognizes only an explicit uppercase first-token marker without a colon", () => {
  for (const output of ["BLOCKED I need an employee ID.", "  BLOCKED\tI need an employee ID.", "BLOCKED", "BLOCKED:"]) {
    assert.equal(isBlocked(output), true, JSON.stringify(output));
  }
  assert.equal(stripFailureClass("BLOCKED I need an employee ID."), "I need an employee ID.");
  for (const output of ["Blocked by hook: try another route", "unBLOCKED", "The word BLOCKED appears here", '"BLOCKED I need an employee ID."']) {
    assert.equal(isBlocked(output), false, JSON.stringify(output));
  }
  assert.equal(stripFailureClass("Blocked by hook: try another route"), "Blocked by hook: try another route");
});

test("runLoop returns a bare BLOCKED marker before invoking the verifier", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions(), history, () => {
      calls++;
      return "BLOCKED I need the employee ID.";
    });
    assert.equal(outcome.stopped, "blocked");
    assert.equal(outcome.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(outcome.verdict, null);
    assert.equal(outcome.metrics.rounds[0].verify, undefined);
    assert.match(outcome.content, /need the employee ID/);
    assert.equal(composeEvidenceSummary("I need the employee ID.", null, { stateCriteria: ["the result is updated"] }), "I need the employee ID.");
  });
});

test("runLoop keeps the colon marker and ordinary narrative on their existing paths", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const blocked = await runLoop(baseOptions(), history, () => { calls++; return "BLOCKED: I need the employee ID."; });
    assert.equal(blocked.stopped, "blocked");
    assert.equal(blocked.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(blocked.verdict, null);
  });

  const narrativeHistory = tmpFile("narrative-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const narrative = await runLoop(baseOptions(), narrativeHistory, () => { calls++; return "Blocked by hook: try another route."; });
    assert.equal(narrative.stopped, "pass");
    assert.equal(narrative.attempts, 1);
    assert.equal(calls, 1);
    assert.ok(narrative.verdict);
  });
});

test("composeDiagnoseQuestion carries the full list of commands a denial offered", () => {
  const verdict = { overall: "fail", criteria: [{ criterion: "b", status: "fail", evidence: "not sent" }] };
  const long = "Permission denied: command \"x reply\" is not allowed. Commands you may run: " + Array.from({ length: 30 }, (_, i) => `aux4 cmd${i} list`).join(", ") + ", aux4 x send.";
  const q = composeDiagnoseQuestion({ goal: "g", doneCriteria: ["b"] }, verdict, [{ command: "x reply", failed: true, result: long, resultSummary: long.slice(0, 300) }]);
  assert.match(q, /Commands you may run: .*aux4 x send/);
});

test("new non-read evidence is not stopped as no-progress", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let n = 0;
    const outcome = await runLoop(baseOptions(), history, (q, h) => {
      n++;
      appendExecutionResult(h, `custom workflow step ${n}`, `New prerequisite evidence: token-${n}`, `c${n}`);
      return "not yet";
    });
    assert.equal(outcome.stopped, "budget");
    assert.equal(n, RETRY_BUDGET + 1);
  });
});

test("renamed nonexistent non-read commands with unchanged outcomes stop as no-progress", async () => {
  const fake = statusSequenceFake(["fail", "unverifiable", "fail"]);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executions = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      executions++;
      const error = executions === 1
        ? `Command not found: invented command ${executions}`
        : `Error executing tool "executeAux4": Command not found: invented command ${executions}`;
      appendExecutionResult(h, `invented command ${executions}`, error, `missing-${executions}`);
      return "No task evidence was produced.";
    });
    assert.equal(outcome.stopped, "no-progress");
    assert.equal(outcome.attempts, 2);
    assert.equal(executions, 2, "a different invalid command name is not a new action or source");
  });
});

test("a new parameter precondition earns one recovery round, then an unchanged failure stops", async () => {
  const fake = statusSequenceFake(["fail", "unverifiable", "fail"]);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executions = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      executions++;
      if (executions === 1) {
        appendExecutionResult(h, "records list", JSON.stringify({ records: [] }), "read-1");
      } else {
        appendExecutionResult(h, `records create --name item --option${executions}`, "Error to enter the value of employeeId", `precondition-${executions}`);
      }
      return "The task remains incomplete.";
    });
    assert.equal(outcome.stopped, "no-progress");
    assert.equal(outcome.attempts, 3, "the distinct precondition is seen once; its identical repetition does not extend retries");
    assert.equal(executions, 3);
  });
});

test("a completed distinct action is recognized without being replayed", async () => {
  const fake = statusSequenceFake(["fail", "unverifiable", "fail"]);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executions = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      executions++;
      const command = "records update --recordId r1";
      const result = executions === 1
        ? JSON.stringify({ status: "done", recordId: "r1" })
        : "Not run: this exact update was already completed in the previous round.";
      appendExecutionResult(h, command, result, `update-${executions}`);
      return "The record update returned.";
    });
    assert.equal(outcome.stopped, "unverifiable-only");
    assert.equal(outcome.attempts, 2, "one verification retry follows the completed state change");
    assert.equal(executions, 2);
    assert.equal(extractAttemptLog(history).filter(attempt => !attempt.failed).length, 1, "the second attempt is refused, not executed");
  });
});

test("staged needs-input remains blocked without treating a renamed command as progress", async () => {
  const fake = statusSequenceFake(["fail"]);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executions = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      executions++;
      if (executions === 1) {
        appendExecutionResult(h, "records create --name item", JSON.stringify({
          status: "needs-input",
          confirmation: { action: "Create", target: "item", emptyFields: ["Required value"], next: "records create --name item --field confirm=yes" }
        }), "create-1");
        return "The tool is waiting for a required value.";
      }
      assert.match(question, /Required fields still empty: Required value/);
      assert.doesNotMatch(question, /Run the confirmation now/);
      return "BLOCKED: the required value is unavailable.";
    });
    assert.equal(outcome.stopped, "blocked");
    assert.equal(outcome.attempts, 1);
    assert.equal(executions, 2);
    const attempts = extractAttemptLog(history);
    assert.equal(attempts.some(attempt => attempt.command.includes("confirm=yes")), false);
  });
});

test("fail/unverifiable drift with unchanged facts stops after one retry", async () => {
  const fake = statusSequenceFake(["fail", "unverifiable", "fail"]);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executions = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      executions++;
      appendExecutionResult(h,
        'agent browser find --url https://example.test/page --question "lookup the required value" --session s' + executions,
        JSON.stringify({ answered: false, question: "lookup the required value", url: "https://example.test/page", session: `s${executions}`, matches: [{ text: "Directory", location: { url: "https://example.test/page/directory" } }] }),
        `read-${executions}`);
      return "The lookup did not return the requested value.";
    });
    assert.equal(outcome.stopped, "no-progress");
    assert.equal(outcome.attempts, 2);
    assert.equal(executions, 2);
    assert.equal(outcome.verdict.criteria[0].status, "unverifiable");
    assert.match(outcome.content, /Not confirmed: the outcome holds — Reason: “same unmet outcome”/,
      "the bounded no-progress stop keeps a grounded reason and does not convert it into success");
  });
});

test("a distinct read source gets one opportunity, but repeating it with metadata-only changes stops", async () => {
  const fake = statusSequenceFake(["fail", "unverifiable", "fail"]);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executions = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      executions++;
      const url = executions === 1 ? "https://example.test/page" : "https://alternate.example.test/page";
      appendExecutionResult(h,
        `agent browser find --url ${url} --question "lookup the required value" --session s${executions}`,
        JSON.stringify({ answered: false, question: "lookup the required value", url, session: `s${executions}`, matches: [{ text: "Directory", location: { url: "https://example.test/page/directory" } }] }),
        `read-${executions}`);
      return "The lookup did not return the requested value.";
    });
    assert.equal(outcome.stopped, "no-progress");
    assert.equal(outcome.attempts, 3, "two retries run: one for the distinct source, then the unchanged repeat stops");
    assert.equal(executions, 3);
  });
});

test("a newly observed required value permits another retry; a duplicate of that value then stops", async () => {
  const fake = statusSequenceFake(["fail", "unverifiable", "fail"]);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executions = 0;
    const outcome = await runLoop(baseOptions(), history, (question, h) => {
      executions++;
      const value = executions === 1 ? "The directory has no matching entry." : "Employee ID E-17 is assigned.";
      appendExecutionResult(h,
        'agent browser find --url https://example.test/page --question "lookup the required value" --session s' + executions,
        JSON.stringify({ answered: executions > 1, question: "lookup the required value", url: "https://example.test/page", session: `s${executions}`, matches: [{ text: value, location: { url: "https://example.test/page/directory" } }] }),
        `read-${executions}`);
      return value;
    });
    assert.equal(outcome.stopped, "no-progress");
    assert.equal(outcome.attempts, 3, "the newly supplied value advances one round before its duplicate is recognized");
    assert.equal(executions, 3);
  });
});

test("missingParameterHints explains aux4's missing-parameter error", () => {
  const hints = missingParameterHints([{ command: "x send --body hi", failed: true, result: "Error executing command: Error to enter the value of to" }]);
  assert.match(hints.join(" "), /missing the required --to parameter/);
  assert.deepEqual(missingParameterHints([{ command: "x", failed: false, result: "ok" }]), []);
});

test("missingParameterHints directs recovery from an unsupported option", () => {
  const hints = missingParameterHints([{
    command: "google calendar events list --calendars primary",
    failed: true,
    result: "Error executing command: Unknown parameter --calendars"
  }]);
  assert.match(hints.join(" "), /exact --help/);
  assert.match(hints.join(" "), /continue the remaining steps/);
  assert.match(hints.join(" "), /Do not retry the rejected option/);
});


test("a round that asked without looking is pushed once before it is verified", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const questions = [];
    const outcome = await runLoop(baseOptions(), history, q => { questions.push(q); return questions.length === 1 ? "What is the date?" : "Moved it."; });
    assert.equal(questions.length, 2);
    assert.match(questions[1], /without using any tool/);
    assert.equal(outcome.content, "Moved it.");
  });
});

test("isSafeReadBack only re-runs an already-successful command with no change verb", () => {
  const candidates = ["x events list", "x events delete 7", "x mail send --to a"];
  assert.equal(isSafeReadBack("x events list", candidates), true);
  assert.equal(isSafeReadBack("x events delete 7", candidates), false);
  assert.equal(isSafeReadBack("x mail send --to a", candidates), false);
  assert.equal(isSafeReadBack("x events list --all", candidates), false);
});

test("the harness reads the state back itself and the verifier judges from it", async () => {
  const fake = makeFakeAux4(`
const args = process.argv.slice(2);
const command = args.join(" ");
if (command.includes("loop-plan.md")) process.stdout.write(JSON.stringify({ goal: "g", doneCriteria: [{ text: "the item is gone", kind: "state" }], steps: [] }));
else if (command.includes("loop-verify.md")) {
  const q = args[args.indexOf("--question") + 1] || "";
  const payload = JSON.parse(q.slice(q.indexOf("{")));
  const seen = payload.currentState ? payload.currentState.result : "";
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => ({ criterion: c.criterion, status: seen.includes("empty") ? "pass" : "fail", evidence: seen })) }));
}
// The harness's own read-back shells out to "\${AUX4_BIN} <bare command>" --
// the same bare form the executeAux4 tool recorded, with no "aux4" prefix.
else if (command === "item list") process.stdout.write("item list empty");
`);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, (q, h) => {
      fs.writeFileSync(h, JSON.stringify({ messages: [
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: "item list" } }] } },
        { role: "tool", tool_call_id: "c1", content: "item list empty" }
      ] }));
      return "removed it";
    });
    assert.equal(outcome.stopped, "pass");
    assert.deepEqual(outcome.verdict.checks, ["item list"]);
  });
});

test("pickFromReply takes a number or an exact command", () => {
  const reads = ["x list", "x get 1"];
  assert.equal(pickFromReply("2", reads), "x get 1");
  assert.equal(pickFromReply("Command 1.", reads), "x list");
  assert.equal(pickFromReply("0", reads), "");
  assert.equal(pickFromReply("use x get 1", reads), "x get 1");
});

test("onlyAnswerFailed is true when every state criterion holds and only answer criteria fail", () => {
  const plan = { doneCriteria: ["moved"], stateCriteria: ["moved"] };
  assert.equal(onlyAnswerFailed(plan, { criteria: [{ criterion: "moved", status: "pass" }, { criterion: "honest", status: "fail" }] }), true);
  assert.equal(onlyAnswerFailed(plan, { criteria: [{ criterion: "moved", status: "fail" }, { criterion: "honest", status: "fail" }] }), false);
  assert.equal(onlyAnswerFailed(plan, { criteria: [{ criterion: "moved", status: "pass" }, { criterion: "honest", status: "pass" }] }), false);
  // No successful tool result yet: nothing to restate, so the retry must act.
  const answerOnly = { criteria: [{ criterion: "honest", status: "fail" }] };
  assert.equal(onlyAnswerFailed({ doneCriteria: ["honest"], stateCriteria: [] }, answerOnly, []), false);
  assert.equal(onlyAnswerFailed({ doneCriteria: ["honest"], stateCriteria: [] }, answerOnly, [{ command: "x", failed: true }]), false);
  assert.equal(onlyAnswerFailed({ doneCriteria: ["honest"], stateCriteria: [] }, answerOnly, [{ command: "x", failed: false }]), true);
  const sentState = { doneCriteria: ["the reply is sent"], stateCriteria: ["the reply is sent"] };
  const unsupportedSend = { criteria: [
    { criterion: "the reply is sent", status: "pass" },
    { criterion: HONESTY_CRITERION, status: "unverifiable" }
  ] };
  assert.equal(onlyAnswerFailed(sentState, unsupportedSend, [
    { command: "google calendar freebusy --timeMin 2026-03-19T09:00:00Z", failed: false, result: "busy" }
  ]), false, "a read-only attempt must not turn an unsupported write into an answer-only retry");
  assert.equal(onlyAnswerFailed(sentState, unsupportedSend, [
    { command: "google gmail send --to devon@example.com", failed: false, result: "sent", source: "sent" }
  ]), true, "after a successful write, an answer-only correction is safe");
  const bookedState = { doneCriteria: ["the trip is booked"], stateCriteria: ["the trip is booked"] };
  const unsupportedBooking = { criteria: [
    { criterion: "the trip is booked", status: "pass" },
    { criterion: HONESTY_CRITERION, status: "unverifiable" }
  ] };
  assert.equal(onlyAnswerFailed(bookedState, unsupportedBooking, [
    { command: "agent browser find --url https://example.test --question 'find trip'", failed: false, result: "booking page" }
  ]), false, "an unsupported booking must still require action after a read-only run");
});

test("capRetryBudget keeps retries on a small tool budget", () => {
  assert.deepEqual(JSON.parse(capRetryBudget('{"budget":{"calls":25,"usd":1}}')).budget, { calls: 10, usd: 1 });
  assert.equal(JSON.parse(capRetryBudget('{"budget":{"calls":4}}')).budget.calls, 4);
  assert.equal(JSON.parse(capRetryBudget("")).budget.calls, 10);
});

test("dropTrailingTextCall removes a tool call written as text, and nothing else", () => {
  const file = tmpFile("history.json", JSON.stringify({ messages: [
    { role: "user", content: "do it" },
    { role: "assistant", content: 'executeAux4("aux4 x list")' }
  ] }));
  assert.equal(dropTrailingTextCall(file), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).messages.length, 1);
  assert.equal(dropTrailingTextCall(file), false);
});

test("a send whose state no read can show is judged from its own successful result", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass", verifierObserves: false });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, (q, h) => {
      fs.writeFileSync(h, JSON.stringify({ messages: [
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: "x mail send --to a" } }] } },
        { role: "tool", tool_call_id: "c1", content: '{"id":"m1","labelIds":["SENT"]}' }
      ] }));
      return "sent it";
    });
    assert.equal(outcome.stopped, "pass");
  });
});

test("pickReadBack picks by word overlap with the state criteria, or nothing", () => {
  const plan = { stateCriteria: ["the Budget review meeting is cancelled on the calendar"] };
  assert.equal(pickReadBack(plan, ["x mail list", "x calendar events list", "x calendar events delete 7"]).command, "x calendar events list");
  assert.equal(pickReadBack({ stateCriteria: ["the reply is on the same thread"] }, ["x calendar events list"]).none, true);
});

test("isReadCommand needs a read verb among the command words and no change verb", () => {
  assert.equal(isReadCommand("aux4 x calendar events list --timeMin 1"), true);
  assert.equal(isReadCommand("aux4 x mail get msg-1"), true);
  assert.equal(isReadCommand("aux4 x calendar events respond --id 1 --response accepted"), false);
  assert.equal(isReadCommand("aux4 x tasks mark --done true"), false);
  assert.equal(isReadCommand("aux4 x events list --then delete"), false);
  assert.equal(isReadCommand("aux4 x sync"), false);
});

test("working rules forbid guessing commands and say how to recover from Command not found", () => {
  assert.match(WORKING_RULES, /Use the installed commands listed above/);
  assert.match(WORKING_RULES, /Never guess a command name/);
  assert.match(WORKING_RULES, /Help output is documentation, not task evidence/);
  assert.match(WORKING_RULES, /use a complete child command path/);
  assert.match(WORKING_RULES, /"Command not found", run --help on its parent group/);
  assert.match(WORKING_RULES, /A filtered miss does not establish absence: try one materially broader scope while preserving explicit user constraints/);
  assert.match(WORKING_RULES, /Do not repeat equivalent filters or superficial rewordings/);
  assert.match(WORKING_RULES, /After a successful lookup, reuse its facts/);
  assert.match(WORKING_RULES, /If group help lists subcommands, choose one and put it before its flags/);
  assert.match(WORKING_RULES, /For a time-only change, keep the item's observed date and time zone/);
  assert.match(WORKING_RULES, /Carry its UTC offset or explicit named zone into machine timestamps/);
  assert.match(WORKING_RULES, /include the complete start-to-end range if both endpoints are present/);
  assert.match(WORKING_RULES, /If a tool reports that a call or token budget is exhausted, stop making tool calls/);
  assert.match(WORKING_RULES, /do not issue back-to-back status checks/);
  assert.match(WORKING_RULES, /executeAux4 adds the aux4 binary/);
});

test("working rules say to re-check a message against tool results before sending it", () => {
  assert.match(WORKING_RULES, /Before sending or submitting a message, re-read the tool results it depends on/);
});

test("findCommands aggregates pkger ranks across queries and leaves out the agent's own commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-"));
  const bin = path.join(dir, "aux4");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help")) {
  const command = args.slice(0, args.indexOf("--help")).join(" ");
  if (command === "google gmail") console.log("gmail\\n  list\\n    --query <optional>\\n  archive\\n    --id <arg> <multiple>");
  else if (command === "google gmail list") console.log("list\\n  --query <optional>\\n    Gmail search query\\n  --maxResults <optional>\\n    Maximum messages");
  else if (command.startsWith("missing group")) process.exit(1);
  else console.log("help for " + command);
  process.exit(0);
}
const q = process.argv[process.argv.indexOf("--query") + 1];
const out = q === "open web page" ? [{command:"aux4 ai agent ask",score:9},{command:"aux4 aux4 pkger find",score:8},{command:"aux4 agent ask",score:7},{command:"aux4 agent browser run",description:"Run a goal.",score:0.1},{command:"aux4 browser open",description:"Open a page.",score:1},{command:"aux4 browser read",score:0.5},{command:"aux4 google gmail trash",score:0.1}]
  : [{command:"aux4 google gmail trash",score:50},{command:"aux4 google gmail list",description:"List messages.",score:40},{command:"aux4 browser open",score:30}];
console.log(JSON.stringify(out));
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const found = findCommands(["open https://example.com/x", "b", ""]);
    assert.deepEqual(found.map(f => f.command), ["aux4 google gmail trash", "aux4 agent browser run", "aux4 browser open", "aux4 google gmail list", "aux4 browser read"]);
    const text = describeFoundCommands(found);
    assert.match(text, /exact syntax from --help/);
    assert.match(text, /Pass the shown command path and flags to executeAux4; it adds the aux4 binary/);
    assert.match(text, /- google gmail \(group; complete child paths: google gmail list, google gmail archive\)/);
    assert.match(text, /--query <optional>/);
    assert.match(text, /--id <arg> <multiple>/);
    assert.doesNotMatch(text, /- aux4 google gmail list/);
    assert.match(text, /Use these flags directly without another help lookup/);
    const fallback = describeFoundCommands([{ command: "aux4 missing group list", description: "List missing items." }]);
    assert.match(fallback, /executeAux4 \{"command": "missing group list --help"\}/);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(describeFoundCommands([]), "");
});

test("findCommands follows a discovered mock preset to the service commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-preset-"));
  const bin = path.join(dir, "aux4");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const q = args[args.indexOf("--query") + 1] || "";
const out = q === "manage the inbox"
  ? [{command:"aux4 mock preset acme inbox",description:"Configure the inbox mock."}]
  : q.startsWith("acme inbox ")
    ? [{command:"aux4 acme inbox list",description:"List inbox messages."}]
    : [];
console.log(JSON.stringify(out));
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const found = findCommands(["manage the inbox"]);
    assert.ok(found.some(item => item.command === "aux4 acme inbox list"));
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findCommands does not promote another service from a preset service search", () => {
  const fake = makeFakeAux4(`const args = process.argv.slice(2);
const q = args[args.indexOf('--query') + 1] || '';
let out = [];
if (q === 'check calendar for time') out = [
  {command:'aux4 mock preset google calendar',description:'Calendar fixture.'},
  {command:'aux4 google calendar events list',description:'List calendar events.'},
  {command:'aux4 google calendar freebusy',description:'Query availability.'}
];
else if (q.startsWith('google calendar ')) out = [
  {command:'aux4 google gmail send',description:'Send an email.'},
  ...Array.from({length:14}, (_, i) => ({command:'aux4 google gmail unrelated-' + i,description:'Unrelated Gmail operation.'})),
  {command:'aux4 google calendar events list',description:'List calendar events.'}
];
console.log(JSON.stringify(out));`);
  return withAux4Bin(fake, async () => {
    const found = findCommands(["check calendar for time", "send a reply"]);
    assert.ok(found.some(item => item.command === "aux4 google calendar events list"));
    assert.ok(found.some(item => item.command === "aux4 google calendar freebusy"));
    assert.equal(found.some(item => item.command.startsWith("aux4 google gmail")), false);
  });
});

test("findCommands parses pkger find's colored text output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-text-"));
  const bin = path.join(dir, "aux4");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const q = args[args.indexOf("--query") + 1] || "";
const yellow = "\\x1b[33m", cyan = "\\x1b[36m", reset = "\\x1b[0m";
if (q.includes("calendar")) {
  console.log(yellow + "aux4 google calendar events list" + reset + "  " + cyan + "(community/google-calendar)" + reset);
  console.log("List events on a calendar.");
} else if (q.includes("email")) {
  console.log(yellow + "aux4 google gmail send" + reset + "  " + cyan + "(community/google-gmail)" + reset);
  console.log("Send an email message.");
} else {
  console.log("No commands or packages found for " + JSON.stringify(q));
}
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const found = findCommands(["read calendar meeting", "send an email"]);
    assert.deepEqual(found.map(item => item.command), ["aux4 google calendar events list", "aux4 google gmail send"]);
    assert.deepEqual(found.map(item => item.description), ["List events on a calendar.", "Send an email message."]);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("command references prefer a matched nested group and spell out full child paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-groups-"));
  const bin = path.join(dir, "aux4");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help")) {
  const command = args.slice(0, args.indexOf("--help")).join(" ");
  if (command === "records") console.log("records\\n  events\\n  Manage records.\\n  search\\n  Search records.");
  else if (command === "records events") console.log("events\\n  list\\n  List events.\\n  update\\n  Update an event.\\n    --recordId <arg>\\n      Existing record.\\n    --begin [optional]\\n      New beginning.\\n    --finish [optional]\\n      New ending.");
  else if (command === "mail") console.log("mail\\n  send\\n  Send a message.\\n    --to <arg>");
  else console.log("help for " + command);
  process.exit(0);
}
console.log(JSON.stringify([]));
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const text = describeFoundCommands([
      { command: "aux4 records", description: "The records command group." },
      { command: "aux4 records events", description: "The records events command group." },
      { command: "aux4 mail", description: "The mail command group." }
    ]);
    assert.match(text, /records events \(group; complete child paths: records events list, records events update\)/);
    assert.match(text, /records \(group; complete child paths: records events, records search\)/);
    assert.match(text, /records events update Parameters: --recordId <arg>, --begin, --finish\./);
    assert.match(text, /mail \(group; complete child paths: mail send\)/);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("command references retain direct ancestor leaves alongside nested group leaves", async () => {
  const fake = makeFakeAux4(`const args = process.argv.slice(2);
const command = args.slice(0, -1).join(' ');
if (command === 'google gmail') console.log('gmail\\n  list\\n  List messages.\\n    --query <arg>\\n      Search query.\\n  get\\n  Read a message.\\n    --messageId <arg>\\n      Message identifier.\\n  labels\\n  Manage labels.\\n' + 'verbose ancestor documentation\\n'.repeat(180));
else if (command === 'google gmail labels') console.log('labels\\n  list\\n  List labels.\\n    --includeSystem\\n      Include system labels.\\n');
else console.log('help for ' + command);
`);
  await withAux4Bin(fake, async () => {
    const text = describeFoundCommands([
      { command: "aux4 google gmail", description: "The Gmail command group." },
      { command: "aux4 google gmail list", description: "List messages." },
      { command: "aux4 google gmail get", description: "Read a message." },
      { command: "aux4 google gmail labels list", description: "List labels." }
    ]);
    assert.match(text, /google gmail labels \(group; complete child paths: google gmail labels list\)/);
    assert.match(text, /google gmail \(group; complete child paths: google gmail list, google gmail get, google gmail labels\)/);
    assert.match(text, /google gmail list Parameters: --query <arg>/);
    assert.match(text, /google gmail get Parameters: --messageId <arg>/);
    assert.match(text, /google gmail labels list Parameters: --includeSystem/);
    assert.ok(text.indexOf("google gmail labels (group") < text.indexOf("google gmail (group"));
    const listedPaths = [...text.matchAll(/^\s*- .*complete child paths: (.*)\)$/gm)]
      .flatMap(([, paths]) => paths.split(", "));
    assert.deepEqual([...new Set(listedPaths)], listedPaths);
    assert.ok(text.length < 6500, `command reference exceeded bounded context: ${text.length}`);
  });
});

test("command references probe actual ancestors to expose useful sibling commands", async () => {
  const fake = makeFakeAux4(`const args = process.argv.slice(2);
const command = args.slice(0, -1).join(' ');
if (command === 'google calendar events') console.log('events\\n  list\\n  List calendar events.\\n');
else if (command === 'google calendar') console.log('calendar\\n  calendars\\n  List calendars.\\n  events\\n  Manage calendar events.\\n  freebusy\\n  Query free/busy information.\\n');
else if (command === 'google') console.log('google\\n  calendar\\n  Calendar tools.\\n  gmail\\n  Gmail tools.\\n');
else console.log('help for ' + command);`);
  await withAux4Bin(fake, async () => {
    const text = describeFoundCommands([
      { command: "aux4 google calendar events list", description: "List calendar events." }
    ]);
    assert.match(text, /google calendar \(group; complete child paths: google calendar calendars, google calendar events, google calendar freebusy\)/);
    assert.match(text, /google calendar freebusy: Query free\/busy information/);
    assert.match(text, /google calendar events \(group; complete child paths: google calendar events list\)/);
    assert.ok(text.length < 6500, `command reference exceeded bounded context: ${text.length}`);
  });
});

test("findCommands stops after an unavailable search instead of repeating a cold-index failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-failure-"));
  const bin = path.join(dir, "aux4");
  const calls = path.join(dir, "calls.txt");
  fs.writeFileSync(bin, `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FIND_CALL_LOG, "called\\n");
process.exit(1);
`, { mode: 0o755 });
  const previousBin = process.env.AUX4_BIN;
  const previousLog = process.env.FIND_CALL_LOG;
  process.env.AUX4_BIN = bin;
  process.env.FIND_CALL_LOG = calls;
  try {
    assert.deepEqual(findCommands(["read calendar", "send email", "update event"]), []);
    assert.equal(fs.readFileSync(calls, "utf8"), "called\n");
  } finally {
    if (previousBin === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previousBin;
    if (previousLog === undefined) delete process.env.FIND_CALL_LOG; else process.env.FIND_CALL_LOG = previousLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sameReadEvidence ignores query/session metadata but notices changed facts", () => {
  const prior = [{
    command: 'agent browser find --question "find a missing order"',
    source: JSON.stringify({ question: "find a missing order", answered: false, answerScore: 0.02, session: "s1", matches: [{ text: "Orders table", location: { url: "/orders" } }] })
  }];
  const repeated = [{
    command: 'agent browser find --question "search all orders for a matching customer"',
    source: JSON.stringify({ question: "search all orders for a matching customer", answered: false, answerScore: 0.04, session: "s2", matches: [{ text: "Orders table", location: { url: "/orders" } }] })
  }];
  const newFact = [{
    command: 'agent browser find --question "search all orders for a matching customer"',
    source: JSON.stringify({ question: "search all orders for a matching customer", answered: false, answerScore: 0.04, session: "s2", matches: [{ text: "Zoe Nolan | ord-0099", location: { url: "/orders?page=3" } }] })
  }];
  assert.equal(sameReadEvidence(repeated, prior), true);
  assert.equal(sameReadEvidence(newFact, prior), false);
  assert.equal(sameReadEvidence(
    [{ command: "jobs status 2", source: JSON.stringify({ state: "RUNNING", duration: "2s" }) }],
    [{ command: "jobs status 2", source: JSON.stringify({ state: "RUNNING", duration: "1s" }) }]
  ), true);
  assert.equal(sameReadEvidence(
    [{ command: "grade list", source: JSON.stringify({ student: "A", score: 92 }) }],
    [{ command: "grade list", source: JSON.stringify({ student: "A", score: 91 }) }]
  ), false);
  assert.equal(sameReadEvidence(
    [{ command: "jobs status 2", failed: true, source: "⛔ policy budget_exceeded: cap reached" }],
    [{ command: "jobs status 2", source: JSON.stringify({ state: "RUNNING" }) }]
  ), false);
});

test("typed browser-find facts ignore ranking/session jitter, order, and previously seen subsets", () => {
  const command = 'agent browser find --url https://example.test/orders --question "find the requested order"';
  const rowA = (session, score = 0.02) => ({
    text: "rec-41 | Customer A | open | Cancel rec-41",
    score,
    session: "record-session-41",
    location: { url: "https://example.test/orders/rec-41", selector: "#row-41", ref: 4 },
    actions: [{
      label: "Cancel rec-41",
      href: "/orders/rec-41/cancel",
      target: { selector: "#row-41", recordId: "rec-41" },
      next: `aux4 agent browser run --session '${session}' --goal 'cancel rec-41' --target '{"selector":"#row-41","recordId":"rec-41"}'`
    }]
  });
  const rowB = (score = 0.03) => ({
    text: "rec-52 | Customer B | open",
    score,
    location: { url: "https://example.test/orders/rec-52", selector: "#row-52", ref: 5 }
  });
  const attempt = (matches, session, answerScore, nextTarget = "#row-41") => ({
    command,
    source: JSON.stringify({
      question: "find the requested order", answered: false, answerScore, session,
      sessionClosed: session === "closed", url: "https://example.test/orders",
      next: `aux4 agent browser run --session '${session}' --goal 'cancel rec-41' --target '{"selector":"${nextTarget}","recordId":"rec-41"}'`,
      rankCalls: 3, usage: { input: 12 }, wallMs: 4, blocks: 10,
      matches
    })
  });
  const prior = [attempt([rowA("s1"), rowB()], "s1", 0.21)];
  const jitterAndPermutation = [attempt([rowB(0.98), rowA("s2", 0.77)], "s2", 0.89)];
  assert.equal(sameReadEvidence(jitterAndPermutation, prior), true);
  assert.equal(sameReadFacts(jitterAndPermutation, prior), true);

  const changedHoistedTarget = [attempt([rowA("s2")], "s2", 0.2, "#row-41-confirm")];
  assert.equal(sameReadFacts(changedHoistedTarget, prior), false, "the hoisted continuation keeps its target significant");

  const subset = [attempt([rowA("s3", 0.11)], "s3", 0.09)];
  assert.equal(sameReadFacts(subset, prior), true, "a subset of rows and actions already observed is not new evidence");

  const newRow = [attempt([rowA("s4"), rowB(), { text: "rec-99 | Customer C", score: 0.02, location: { url: "https://example.test/orders/rec-99", selector: "#row-99" } }], "s4", 0.31)];
  assert.equal(sameReadFacts(newRow, prior), false, "a newly observed row is progress");

  const newActionTarget = [attempt([{ ...rowA("s5"), actions: [{
    label: "Cancel rec-41", href: "/orders/rec-41/cancel",
    target: { selector: "#row-41-confirm", recordId: "rec-41" },
    next: "aux4 agent browser run --session 's5' --goal 'cancel rec-41' --target '{\"selector\":\"#row-41-confirm\",\"recordId\":\"rec-41\"}'"
  }] }], "s5", 0.32)];
  assert.equal(sameReadFacts(newActionTarget, prior), false, "a different observed action target is progress");

  const changedNestedUrl = [attempt([{ ...rowA("s6"), location: { url: "https://example.test/other-record", selector: "#row-41", ref: 4 } }], "s6", 0.2)];
  assert.equal(sameReadFacts(changedNestedUrl, prior), false, "nested factual URLs remain significant");
  const changedRecordSession = [attempt([{ ...rowA("s7"), session: "record-session-42" }], "s7", 0.2)];
  assert.equal(sameReadFacts(changedRecordSession, prior), false, "nested record session fields remain factual");
  assert.equal(sameReadEvidence(
    [{ command: "records list", source: JSON.stringify({ score: 0.2, session: "record-session" }) }],
    [{ command: "records list", source: JSON.stringify({ score: 0.3, session: "record-session" }) }]
  ), false, "nonbrowser score fields remain factual");
});

test("browser pageEvidence ignores ranking jitter but preserves newly surfaced page facts", () => {
  const command = 'agent browser find --url https://example.test/orders --question "find the requested record"';
  const result = (session, page2Matches) => ({
    command,
    source: JSON.stringify({
      question: "find the requested record", answered: false, session, url: "https://example.test/orders",
      matches: [{ text: "Page one global leader", score: 0.91, location: { url: "https://example.test/orders?page=1" } }],
      pageEvidence: {
        coverage: "ranked-top-k", complete: false, limitPerPage: 2,
        pages: [
          { page: 1, url: "https://example.test/orders?page=1", matches: [
            { text: "Page one global leader", score: 0.91, location: { url: "https://example.test/orders?page=1" } },
            { text: "Page one alternate", score: 0.42, location: { url: "https://example.test/orders?page=1#b" } }
          ] },
          { page: 2, url: "https://example.test/orders?page=2", matches: page2Matches }
        ]
      }
    })
  });
  const prior = [result("s1", [
    { text: "Page two candidate A", score: 0.21, location: { url: "https://example.test/orders?page=2#a" } },
    { text: "Page two candidate B", score: 0.17, location: { url: "https://example.test/orders?page=2#b" } }
  ])];
  const jitter = [result("s2", [
    { text: "Page two candidate B", score: 0.89, location: { url: "https://example.test/orders?page=2#b" } },
    { text: "Page two candidate A", score: 0.77, location: { url: "https://example.test/orders?page=2#a" } }
  ])];
  assert.equal(sameReadEvidence(jitter, prior), true, "score and candidate-order jitter is not new evidence");

  const reversedPages = JSON.parse(jitter[0].source);
  reversedPages.pageEvidence.pages.reverse();
  assert.equal(sameReadEvidence([{ ...jitter[0], source: JSON.stringify(reversedPages) }], prior), true,
    "page ordering is canonicalized by page number while page and URL facts remain attached");

  assert.equal(sameReadEvidence([result("s4", [
    { text: "Page two candidate A", score: 0.99, location: { url: "https://example.test/orders?page=2#a" } }
  ])], prior), true, "a candidate subset already present in pageEvidence is not new evidence");

  const newCandidate = [result("s3", [
    { text: "Page two candidate A", score: 0.23, location: { url: "https://example.test/orders?page=2#a" } },
    { text: "Page two candidate B", score: 0.14, location: { url: "https://example.test/orders?page=2#b" } },
    { text: "Page two newly surfaced record", score: 0.09, location: { url: "https://example.test/orders?page=2#new" } }
  ])];
  assert.equal(sameReadEvidence(newCandidate, prior), false, "new per-page candidate identity/content is progress");

  const newlyVisitedEmptyPage = JSON.parse(prior[0].source);
  newlyVisitedEmptyPage.pageEvidence.pages.push({ page: 3, url: "https://example.test/orders?page=3", matches: [] });
  assert.equal(sameReadEvidence([{ ...prior[0], source: JSON.stringify(newlyVisitedEmptyPage) }], prior), false,
    "a newly visited page remains a fact even when its bounded rank result is empty");

  const malformed = JSON.parse(prior[0].source);
  malformed.pageEvidence.pages.push(null);
  assert.equal(sameReadEvidence([{ ...prior[0], source: JSON.stringify(malformed) }], prior), false,
    "malformed optional page evidence is preserved safely and does not throw");

  for (const unknownShape of [
    "unexpected evidence shape",
    ["unexpected evidence shape"],
    { coverage: "ranked-top-k", pages: "not-an-array" }
  ]) {
    const changedMalformedEvidence = JSON.parse(prior[0].source);
    changedMalformedEvidence.pageEvidence = unknownShape;
    assert.equal(sameReadEvidence([{ ...prior[0], source: JSON.stringify(changedMalformedEvidence) }], prior), false,
      "changed primitive, array, or non-array-pages evidence remains visible to repeat comparison");
  }
});

test("fact comparison preserves browser-find source URLs and nested fact locators", () => {
  const prior = [{
    command: 'agent browser find --url https://example.test/a --question "find the assigned id" --session s1',
    source: JSON.stringify({ answered: false, question: "find the assigned id", url: "https://example.test/a", session: "s1", timestamp: "2026-01-01T00:00:00Z", matches: [{ text: "Directory", location: { url: "https://example.test/a/records" }, timestamp: "2025-12-01" }] })
  }];
  const locatorOnly = [{
    command: 'agent browser find --url https://example.test/a --question "find the assigned id" --session s2',
    source: JSON.stringify({ answered: false, question: "find the assigned id", url: "https://example.test/a", session: "s2", timestamp: "2026-01-02T00:00:00Z", matches: [{ text: "Directory", location: { url: "https://example.test/a/records" }, timestamp: "2025-12-01" }] })
  }];
  assert.equal(sameReadFacts(locatorOnly, prior), true);
  assert.equal(hasNewReadSource(locatorOnly, prior), false, "session and question changes are not new sources");

  const changedResultSource = [{
    ...locatorOnly[0],
    source: JSON.stringify({ answered: false, question: "find the assigned id", url: "https://example.test/b", session: "s2", timestamp: "2026-01-02T00:00:00Z", matches: [{ text: "Directory", location: { url: "https://example.test/a/records" }, timestamp: "2025-12-01" }] })
  }];
  assert.equal(sameReadFacts(changedResultSource, prior), false, "the result URL identifies the observed source");

  const changedSource = [{
    ...locatorOnly[0],
    command: 'agent browser find --url https://different.example.test/directory --question "find the assigned id" --session s3'
  }];
  assert.equal(hasNewReadSource(changedSource, prior), true, "unrelated source URLs remain distinct");
  assert.equal(sameReadFacts(changedSource, prior), true, "same returned URL and facts remain comparable despite a different command locator");
  assert.equal(hasNewReadSource([{
    ...prior[0], command: 'agent browser inspect --url https://example.test/a --offset 2'
  }], [{
    ...prior[0], command: 'agent browser inspect --url https://example.test/a --offset 1'
  }]), true, "a distinct observed page/block offset remains a new source opportunity");

  const changedRecordLocator = [{
    ...locatorOnly[0],
    source: JSON.stringify({ answered: false, url: "https://example.test/a", matches: [{ text: "Directory", location: { url: "https://example.test/a/records/assigned-id" }, timestamp: "2025-12-01" }] })
  }];
  assert.equal(sameReadFacts(changedRecordLocator, prior), false, "nested record/link locations remain evidence");
  const changedRecordDate = [{
    ...prior[0],
    source: JSON.stringify({ answered: false, url: "https://example.test/a", matches: [{ text: "Directory", location: { url: "https://example.test/a/records" }, timestamp: "2025-12-02" }] })
  }];
  assert.equal(sameReadFacts(changedRecordDate, prior), false, "timestamps inside returned records remain evidence");

  const newValue = [{
    ...prior[0],
    source: JSON.stringify({ answered: true, url: "https://example.test/a", matches: [{ text: "Employee ID: E-17", location: { url: "https://example.test/a/records" } }] })
  }];
  assert.equal(sameReadFacts(newValue, prior), false, "a newly supplied required value is progress");
});

test("a newly supplied required field differs from an unchanged missing-input result", () => {
  const command = "agent forms inspect --url https://example.test/form";
  const missing = [{ command, source: JSON.stringify({ status: "needs-input", session: "s1", finalUrl: "https://example.test/form", confirmation: { emptyFields: ["Employee ID"] } }) }];
  const supplied = [{ command, source: JSON.stringify({ status: "ready", session: "s2", finalUrl: "https://example.test/form", confirmation: { emptyFields: [] }, observedFields: [{ label: "Employee ID", value: "E-17" }] }) }];
  assert.equal(sameReadFacts(supplied, missing), false);
  assert.equal(hasNewReadSource(supplied, missing), false, "the value is progress because evidence changed, not because the source changed");
});

test("read/change classification ignores flag values and recognizes command actions", () => {
  assert.equal(isReadCommand('google gmail list --query "archive the promotions"'), true);
  assert.equal(isReadCommand('jobs run "aux4 email list all"'), false);
  assert.equal(isChangeCommand('todo add --title "open the dashboard"'), true);
  assert.equal(isChangeCommand('todo list --query "archive"'), false);
});

test("attempt log treats timeouts, hook blocks, and policy denials as failures", () => {
  const file = tmpFile("failed-results.json", JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [
      { id: "timeout", name: "executeAux4", args: { command: "email list all" } },
      { id: "hook", name: "executeAux4", args: { command: "jobs status 2" } },
      { id: "budget", name: "executeAux4", args: { command: "jobs status 2" } }
    ] } },
    { role: "tool", tool_call_id: "timeout", name: "executeAux4", content: 'TIMEOUT: "email list all" was killed' },
    { role: "tool", tool_call_id: "hook", name: "executeAux4", content: "Blocked by hook: Error: repeated lookup" },
    { role: "tool", tool_call_id: "budget", name: "executeAux4", content: "⛔ policy budget_exceeded: budget exceeded (spent 26 calls, cap 25)" }
  ] }));
  const attempts = extractAttemptLog(file);
  assert.deepEqual(attempts.map(attempt => attempt.failed), [true, true, true]);
  assert.equal(isBudgetExceededResult(attempts[2].source), true);
  fs.rmSync(file, { force: true });
});

test("runAux4Monitored stops the inner agent when the tool budget is denied", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const pidFile = path.join(dir, "pid");
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--history') + 1];
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => fs.writeFileSync(file, JSON.stringify({ messages: [
  { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'denied', name: 'executeAux4', args: { command: 'jobs status 2' } }] } },
  { role: 'tool', tool_call_id: 'denied', name: 'executeAux4', content: '⛔ policy budget_exceeded: budget exceeded (spent 26 calls / cap 25)' }
] })), 40);
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25 });
    assert.equal(result.budgetExceeded, true);
    assert.equal(result.ok, false);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored stops after the same deterministic command error repeats", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repeat-error-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const pidFile = path.join(dir, "pid");
  const failure = "Error executing command: Command not found: community/google-gmail";
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--history') + 1];
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => fs.writeFileSync(file, JSON.stringify({ messages: [
  { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'missing-1', name: 'executeAux4', args: { command: 'community/google-gmail --help' } }] } },
  { role: 'tool', tool_call_id: 'missing-1', name: 'executeAux4', content: ${JSON.stringify(failure)} },
  { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'missing-2', name: 'executeAux4', args: { command: 'community/google-gmail --help' } }] } },
  { role: 'tool', tool_call_id: 'missing-2', name: 'executeAux4', content: ${JSON.stringify(failure)} }
] })), 40);
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25 });
    assert.equal(result.noProgress, true);
    assert.equal(result.budgetExceeded, false);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored stops on a repeated hook-block aggregate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const pidFile = path.join(dir, "pid");
  const blocked = 'Error executing tool "executeAux4": Aborting: a hook has blocked agent:browser/run 3 times. Last reason: ACTION_CHECK_SCOPE_DENIED: The requested target is not available in this action scope.';
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--history') + 1];
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => fs.writeFileSync(file, JSON.stringify({ messages: [
  { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'blocked-aggregate', name: 'executeAux4', args: { command: 'agent browser run --goal "archive the selected record"' } }] } },
  { role: 'tool', tool_call_id: 'blocked-aggregate', name: 'executeAux4', content: ${JSON.stringify(blocked)} }
] })), 40);
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25 });
    assert.equal(result.noProgress, true);
    assert.equal(result.budgetExceeded, false);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored refuses jittered browser-find repetitions through persisted tool history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repeat-transient-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const command = 'agent browser find --url https://example.test/orders --question "find the requested order"';
  const messages = [];
  for (let i = 0; i < 3; i++) {
    const id = `find-${i}`;
    messages.push({ role: "assistant_with_tool", content: { tool_calls: [{ id, name: "executeAux4", args: { command } }] } });
    const rowA = {
      text: "rec-41 | Customer A | open | Cancel rec-41",
      score: [0.11, 0.98, 0.32][i],
      location: { url: "https://example.test/orders/rec-41", selector: "#row-41", ref: 4 },
      actions: [{
        label: "Cancel rec-41", href: "/orders/rec-41/cancel",
        target: { selector: "#row-41", recordId: "rec-41" },
        next: `aux4 agent browser run --session 's${i}' --goal 'cancel rec-41' --target '{"selector":"#row-41","recordId":"rec-41"}'`
      }]
    };
    const rowB = { text: "rec-52 | Customer B | open", score: [0.23, 0.04, 0.78][i], location: { url: "https://example.test/orders/rec-52", selector: "#row-52", ref: 5 } };
    const matches = i === 0 ? [rowA, rowB] : i === 1 ? [rowB, rowA] : [rowB];
    messages.push({
      role: "tool",
      tool_call_id: id,
      name: "executeAux4",
      content: JSON.stringify({
        question: "find the requested order",
        answered: false,
        answerScore: [0.27, 0.29, 0.28][i],
        session: `session-${i}`,
        sessionClosed: i === 2,
        next: `aux4 agent browser run --session 'session-${i}' --goal 'cancel rec-41' --target '{"selector":"#row-41","recordId":"rec-41"}'`,
        url: "https://example.test/orders",
        title: "Records",
        granularity: "block",
        rankCalls: i + 1,
        usage: { input: 100 + i },
        wallMs: i + 1,
        blocks: 10,
        matches
      })
    });
  }
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
setTimeout(() => fs.writeFileSync(${JSON.stringify(history)}, ${JSON.stringify(JSON.stringify({ messages }))}), 40);
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25 });
    assert.equal(result.noProgress, true);
    assert.equal(result.budgetExceeded, false);
    assert.equal(result.ok, false);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored keeps an identical action when the result shows new evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repeat-new-evidence-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const command = 'agent browser find --url https://example.test/orders --question "find the requested order"';
  const messages = [];
  for (let i = 0; i < 3; i++) {
    const id = `search-${i}`;
    messages.push({ role: "assistant_with_tool", content: { tool_calls: [{ id, name: "executeAux4", args: { command } }] } });
    const rowA = { text: "rec-41 | Customer A", score: 0.1 + i, location: { url: "https://example.test/orders/rec-41", selector: "#row-41" } };
    const rowB = { text: "rec-52 | Customer B", score: 0.9 - i, location: { url: "https://example.test/orders/rec-52", selector: "#row-52" } };
    const matches = i === 0 ? [rowA] : [rowA, rowB];
    messages.push({ role: "tool", tool_call_id: id, name: "executeAux4", content: JSON.stringify({
      question: "find the requested order", answered: false, url: "https://example.test/orders",
      answerScore: 0.1 + i, session: `s${i}`, matches
    }) });
  }
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
setTimeout(() => fs.writeFileSync(${JSON.stringify(history)}, ${JSON.stringify(JSON.stringify({ messages }))}), 40);
setTimeout(() => process.exit(0), 150);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25 });
    assert.equal(result.noProgress, false);
    assert.equal(result.ok, true);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored stops on the repeated-action refusal emitted by executeAux4", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repeat-action-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const pidFile = path.join(dir, "pid");
  const refusal = 'Error executing tool "executeAux4": Aborting: the same action has returned the same result 4 times, whatever values were passed. The agent is not making progress. Last result was: {"answered":true}';
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--history') + 1];
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => fs.writeFileSync(file, JSON.stringify({ messages: [
  { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'repeat-action', name: 'executeAux4', args: { command: 'agent browser find --question "What is on this page?"' } }] } },
  { role: 'tool', tool_call_id: 'repeat-action', name: 'executeAux4', content: ${JSON.stringify(refusal)} }
] })), 40);
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25 });
    assert.equal(result.noProgress, true);
    assert.equal(result.budgetExceeded, false);
    assert.equal(result.ok, false);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored stops after the same no-op repeat refusal twice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repeat-refusal-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const pidFile = path.join(dir, "pid");
  const command = 'google gmail list --query "label:INBOX"';
  const refusal = "Not run: you have already made this exact call 2 times and it returned the same result every time.";
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--history') + 1];
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => fs.writeFileSync(file, JSON.stringify({ messages: [
  { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'repeat-1', name: 'executeAux4', args: { command: ${JSON.stringify(command)} } }] } },
  { role: 'tool', tool_call_id: 'repeat-1', name: 'executeAux4', content: ${JSON.stringify(refusal)} },
  { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'repeat-2', name: 'executeAux4', args: { command: ${JSON.stringify(command)} } }] } },
  { role: 'tool', tool_call_id: 'repeat-2', name: 'executeAux4', content: ${JSON.stringify(refusal)} }
] })), 40);
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25 });
    assert.equal(result.noProgress, true);
    assert.equal(result.ok, false);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored resolves a normally completed execution as successful", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successful-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  fs.writeFileSync(history, JSON.stringify({ messages: [] }));
  fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.stdout.write('finished');\n", { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history);
    assert.deepEqual(result, {
      ok: true,
      status: 0,
      signal: null,
      stdout: "finished",
      stderr: "",
      budgetExceeded: false,
      noProgress: false
    });
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored yields on a fresh confirmation before the child can issue another tool call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "confirmation-yield-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const next = "agent browser run --session 's1' --goal 'Save the record' --field 'confirm=yes'";
  const pending = JSON.stringify({ status: "needs-input", confirmation: { action: "Save", target: "record", emptyFields: [], next } });
  const baseline = { messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "old", name: "executeAux4", args: { command: "agent browser run --field confirm=yes" } }] } },
    { role: "tool", tool_call_id: "old", name: "executeAux4", content: pending }
  ] };
  fs.writeFileSync(history, JSON.stringify(baseline));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const file = ${JSON.stringify(history)};
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
setTimeout(() => {
  data.messages.push(
    { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'fresh', name: 'executeAux4', args: { command: 'agent browser run --field confirm=yes' } }] } },
    { role: 'tool', tool_call_id: 'fresh', name: 'executeAux4', content: ${JSON.stringify(pending)} }
  );
  fs.writeFileSync(file, JSON.stringify(data));
}, 40);
setTimeout(() => {
  data.messages.push(
    { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'after', name: 'executeAux4', args: { command: 'agent browser inspect --session s1 --url https://example.test/list' } }] } },
    { role: 'tool', tool_call_id: 'after', name: 'executeAux4', content: 'navigated' }
  );
  fs.writeFileSync(file, JSON.stringify(data));
}, 500);
setInterval(() => {}, 10000);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25, yieldOnConfirmationContract: true });
    assert.equal(result.confirmationPending, true);
    assert.equal(result.noProgress, false);
    assert.equal(result.budgetExceeded, false);
    const attempts = extractAttemptLog(history);
    assert.deepEqual(attempts.map(attempt => attempt.callId), ["old", "fresh"], "prior contract is ignored, and the later navigation call never runs");
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAux4Monitored does not yield on failed or terminal confirmation-shaped results", async () => {
  for (const { name, content, status } of [
    { name: "failed", content: 'Blocked by hook: {"status":"needs-input","confirmation":{"action":"Save","target":"record","emptyFields":[],"next":"agent browser run --session s1 --field confirm=yes"}}', status: true },
    { name: "done", content: JSON.stringify({ status: "done", submitted: true, confirmation: { action: "Save", target: "record", emptyFields: [], next: "agent browser run --session s1 --field confirm=yes" } }), status: true },
    { name: "nested", content: JSON.stringify({ status: "ready", record: { status: "needs-input", confirmation: { action: "Save", target: "record", emptyFields: [], next: "agent browser run --session s1 --field confirm=yes" } } }), status: true }
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `confirmation-${name}-`));
    const bin = path.join(dir, "aux4");
    const history = path.join(dir, "history.json");
    fs.writeFileSync(history, JSON.stringify({ messages: [] }));
    const resultHistory = JSON.stringify({ messages: [
      { role: "assistant_with_tool", content: { tool_calls: [{ id: "result", name: "executeAux4", args: { command: "records save --recordId r1" } }] } },
      { role: "tool", tool_call_id: "result", name: "executeAux4", content }
    ] });
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(history)}, ${JSON.stringify(resultHistory)});
`, { mode: 0o755 });
    const previous = process.env.AUX4_BIN;
    process.env.AUX4_BIN = bin;
    try {
      const result = await runAux4Monitored(["--history", history], history, { pollInterval: 25, yieldOnConfirmationContract: true });
      assert.equal(result.confirmationPending, undefined, `${name} must not be treated as a pending yield`);
      assert.equal(result.ok, status, `${name} output should retain the command's normal completion status`);
    } finally {
      if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("runLoop stops when a retry changes the query but reads the same evidence", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions(), history, (_question, file) => {
      calls++;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const id = `read-${calls}`;
      const question = calls === 1 ? "find the missing order" : "search all orders for that customer";
      data.messages.push(
        { role: "assistant_with_tool", content: { tool_calls: [{ id, name: "executeAux4", args: { command: `agent browser find --question \"${question}\"` } }] } },
        { role: "tool", tool_call_id: id, name: "executeAux4", content: JSON.stringify({ question, answered: false, answerScore: 0.03, session: `s${calls}`, matches: [{ text: "Orders table", location: { url: "/orders" } }] }) }
      );
      fs.writeFileSync(file, JSON.stringify(data));
      return "The requested record was not found.";
    });
    assert.equal(outcome.stopped, "no-progress");
    assert.equal(outcome.attempts, 2);
    assert.equal(calls, 2);
  });
});

test("runLoop stops without verifying again after a tool-budget denial", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("budget-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executeCalls = 0;
    const outcome = await runLoop(baseOptions(), history, (_question, file) => {
      executeCalls++;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      data.messages.push(
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "budget-denied", name: "executeAux4", args: { command: "jobs status 2" } }] } },
        { role: "tool", tool_call_id: "budget-denied", name: "executeAux4", content: "⛔ policy budget_exceeded: budget exceeded (spent 26 calls / cap 25)" }
      );
      fs.writeFileSync(file, JSON.stringify(data));
      return "The execution budget was exhausted.";
    });
    assert.equal(outcome.stopped, "tool-budget");
    assert.equal(outcome.attempts, 1);
    assert.equal(executeCalls, 1);
    assert.match(outcome.content, /remaining work could not be confirmed/);
  });
});

test("runLoop verifies the evidence after the inner executor reports no progress", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("stalled-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let executeCalls = 0;
    const outcome = await runLoop(baseOptions(), history, () => {
      executeCalls++;
      return { content: "The outcome holds.", stopReason: "no-progress" };
    });
    assert.equal(outcome.stopped, "pass");
    assert.equal(outcome.attempts, 1);
    assert.equal(executeCalls, 1);
    assert.equal(outcome.content, "The outcome holds.");
  });
});

test("command lookup searches plan phrases, a task step, and the original request", () => {
  assert.deepEqual(lookupQueries("Book a trip", { steps: ["s1"], lookFor: ["fill and submit a form on a web page"] }), ["fill and submit a form on a web page", "s1", "Book a trip"]);
  assert.deepEqual(lookupQueries("Book a trip", { steps: ["s1"], lookFor: [] }), ["Book a trip", "s1"]);
  assert.deepEqual(lookupQueries("Book a trip", { steps: ["s1"] }), ["Book a trip", "s1"]);
});

test("a capability with a goal-level agent is delegated: its low-level commands are denied to the calling agent", () => {
  const delegations = activeDelegations(new Set(["main", "agent", "agent:browser", "browser"]));
  assert.equal(delegations.length, 1);
  assert.match(delegations[0].note, /executeAux4 with command "agent browser run --url/);
  assert.match(delegations[0].note, /Reuse a returned live session id/);
  assert.match(delegations[0].note, /the "agent browser" command group is available/);
  assert.match(delegations[0].note, /For any task performed on a web page, use executeAux4/);
  assert.deepEqual(delegations[0].entrypoints, ["run", "find", "inspect"]);
  assert.match(delegations[0].note, /deterministic read of extracted content on the current rendered page/);
  assert.match(delegations[0].note, /does not require semantic ranking/);
  assert.match(delegations[0].note, /not every visible text fragment, other pages, or the whole website/);
  assert.match(delegations[0].note, /ranked evidence, which may return relevant matches without proving that its list is exhaustive/);
  assert.match(delegations[0].planningScope, /does not establish website-wide or paginated collection completeness/);
  assert.deepEqual(delegatedDenyPatterns(delegations), ["browser", "browser *", "aux4 browser", "aux4 browser *"]);
  assert.deepEqual(activeDelegations(new Set(["main", "browser"])), []);
  const policy = JSON.parse(addDenyPatterns('{"budget":{"calls":60},"deny":[{"executeAux4":["x"]}]}', ["browser *"]));
  assert.deepEqual(policy.budget, { calls: 60 });
  assert.deepEqual(policy.deny, [{ executeAux4: ["x"] }, { executeAux4: ["browser *"] }]);
  assert.equal(addDenyPatterns("{}", []), "{}");
});

test("the execute question carries the delegation note", () => {
  const q = composeExecuteQuestion("do it", { doneCriteria: ["done"], steps: [] }, "", "", "Web pages: use aux4 agent browser run");
  assert.match(q, /Web pages: use aux4 agent browser run/);
});

test("working rules forbid making up a value and submitting without it", () => {
  assert.match(WORKING_RULES, /Never make up a value/);
  assert.match(WORKING_RULES, /If a required value cannot be found, do not submit or send/);
});

test("enteredValues reads --field values and skips the confirmation and placeholders", () => {
  const cmd = `agent browser run --session 'a0' --goal 'g' --field 'Full name=Jamie Fox' --field "Email=jamie@example.com" --field 'Employee id=<value>' --field 'confirm=yes'`;
  assert.deepEqual(enteredValues(cmd), [{ label: "Full name", value: "Jamie Fox" }, { label: "Email", value: "jamie@example.com" }, { label: "Employee id", value: "<value>" }]);
});

test("a value that appears in no tool result and not in the request is flagged as made up", () => {
  const request = "Register for membership at http://127.0.0.1:7400/membership for Jamie Fox, jamie@example.com. Use the employee id on file.";
  const attempts = [
    { command: "kb search Jamie Fox employee id", source: "No documents have been indexed yet." },
    { command: "agent browser run --session 'a0' --goal 'g' --field 'Full name=Jamie Fox' --field 'Email=jamie@example.com' --field 'Employee id=12345'", source: "{}" }
  ];
  assert.deepEqual(unsourcedValues(attempts, request).map(u => u.value), ["12345"]);
  const verdict = applyProvenance({ overall: "pass", criteria: [{ criterion: "registered", status: "pass", evidence: "" }] }, attempts, request);
  assert.equal(verdict.overall, "fail");
  assert.match(verdict.criteria.at(-1).evidence, /"Employee id" = "12345" appears neither in the request nor in any tool result/);
});

test("values reformatted from the request or read from an earlier result count as sourced", () => {
  const request = "Fill out the contact form for Priya Shah, date of birth 14/03/1990.";
  const attempts = [
    { command: "google gmail get --messageId m1", source: "Your shipping confirmation code is QZ-58213." },
    { command: "agent browser run --field 'Full name=Priya Shah' --field 'Date of birth=1990-03-14' --field 'Code=QZ-58213'", source: "" }
  ];
  assert.deepEqual(unsourcedValues(attempts, request), []);
  const v = { overall: "pass", criteria: [] };
  assert.equal(applyProvenance(v, attempts, request), v);
});

test("a value only counts as sourced from results received BEFORE it was used", () => {
  const attempts = [
    { command: "agent browser run --field 'Code=QZ-1'", source: "" },
    { command: "google gmail get --messageId m1", source: "code QZ-1" }
  ];
  assert.equal(unsourcedValues(attempts, "save the form").length, 1);
});

function heldRound(fields) {
  return JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: `agent browser run --session 's1' --goal 'register' ${fields}` } }] } },
    { role: "tool", tool_call_id: "c1", content: "{\"status\":\"needs-input\",\"reason\":\"Register cannot be undone\"}" },
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c2", name: "executeAux4", args: { command: "agent browser run --session 's1' --goal 'register' --field 'confirm=yes'" } }] } },
    { role: "tool", tool_call_id: "c2", content: "⛔ policy denied_action: policy denies executeAux4 \"agent browser run --session 's1' --goal 'register' --field 'confirm=yes'\". Choose another approach." }
  ] });
}

test("a held confirmation whose values all have a source is released: the next round runs it with the gate open", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Register Jamie Fox, jamie@example.com, employee id E-77." };
    const seen = [];
    const outcome = await runLoop(options, history, (question, h) => {
      seen.push({ question, gate: [...(options.gateDeny || [])] });
      if (seen.length === 1) fs.writeFileSync(h, heldRound("--field 'Full name=Jamie Fox' --field 'Employee id=E-77'"));
      return seen.length === 1 ? "waiting for the confirmation" : "registered";
    });
    assert.deepEqual(seen[0].gate, ["*confirm=yes*", "*\"confirm\"*"]);
    assert.match(seen[1].question, /Run the confirmation now, exactly as before: agent browser run --session 's1' --goal 'register' --field 'confirm=yes'/);
    assert.deepEqual(seen[1].gate, []);
    assert.equal(outcome.stopped, "pass");
  });
});

test("a held confirmation with a made-up value is never released", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Register Jamie Fox, jamie@example.com. Use the employee id on file." };
    const seen = [];
    await runLoop(options, history, (question, h) => {
      seen.push({ question, gate: [...(options.gateDeny || [])] });
      if (seen.length === 1) fs.writeFileSync(h, heldRound("--field 'Full name=Jamie Fox' --field 'Employee id=12345'"));
      return "done";
    });
    assert.match(seen[1].question, /This call was NOT run/);
    assert.match(seen[1].question, /"Employee id" = "12345"/);
    assert.ok(seen.every(s => s.gate.includes("*confirm=yes*")), "the gate never opens");
  });
});

test("a placeholder copied verbatim is never a sourced value, even when its word appears in the output that offered it", () => {
  const request = "Fill out the contact form for Priya Shah.";
  const attempts = [
    { command: "agent browser run --url http://x/contact --goal 'g'", source: 'needs-input: pass --field "Full name=<value>" --field "Message=<value>"' },
    { command: "agent browser run --session 's' --goal 'g' --field 'Full name=<value>' --field 'Message=<value>' --field 'confirm=yes'", source: "" }
  ];
  assert.deepEqual(unsourcedValues(attempts, request).map(u => `${u.label}=${u.value}`), ["Full name=<value>", "Message=<value>"]);
});

// --- HARN-034: the harness's own read-back actually runs ---------------------

test("runReadBack prepends the aux4 binary -- the recorded command is bare, with no 'aux4' of its own (HARN-034)", () => {
  // The attempt log stores the executeAux4 tool's own argument, which never
  // includes a leading "aux4" (aux4/ai-agent's own docs: "without the aux4
  // prefix"). Shelling that bare string out directly, as the code did before
  // this fix, tries to run a program literally named "google" or "agent" and
  // always fails, which is why checks.length was 0 on every round that relied
  // on it (calendar-cancel, products-cheapest-match, reply-decline-conflict).
  const fake = makeFakeAux4(`
const args = process.argv.slice(2);
if (args.join(" ") === "google calendar events list --query x") process.stdout.write("still there");
`);
  const prior = process.env.AUX4_BIN;
  process.env.AUX4_BIN = fake;
  try {
    const result = runReadBack('google calendar events list --query x');
    assert.equal(result.ok, true);
    assert.equal(result.output, "still there");
  } finally {
    if (prior === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = prior;
  }
});

test("runReadBack fails when the bare command is run without the binary in front of it (the bug this fixes)", () => {
  // Demonstrates the failure mode directly: a shell has no program named
  // "google", so running the bare recorded command verbatim always errors.
  const result = spawnSyncBare("google calendar events list --query x");
  assert.notEqual(result.status, 0);
});

test("isNoChangeCriterion recognizes an absence-of-change criterion by its own wording, not by any task's exact phrase (HARN-034)", () => {
  assert.equal(isNoChangeCriterion("no changes were made to the site at http://x/products"), true);
  assert.equal(isNoChangeCriterion("nothing was submitted on the form"), true);
  assert.equal(isNoChangeCriterion("the request was completed without modifying the record"), true);
  assert.equal(isNoChangeCriterion("the Budget review meeting is deleted from the calendar"), false);
  assert.equal(isNoChangeCriterion("a reply is sent to the unread email"), false);
});

test("requireOwnObservation passes a no-change state criterion deterministically when no change-verb command ran (products-cheapest-match)", () => {
  const verdict = { overall: "pass", criteria: [
    { criterion: "no changes were made to the site at http://x/products", status: "pass", evidence: "the action was a find, not a change" }
  ] };
  const attempts = [{ command: "agent browser find --url http://x/products \"cheapest headphone\"", failed: false }];
  const out = requireOwnObservation(verdict, [], ["no changes were made to the site at http://x/products"], attempts);
  assert.equal(out.overall, "pass");
  assert.equal(out.criteria[0].status, "pass");
  assert.match(out.criteria[0].evidence, /no action that could change anything was run/);
});

test("requireOwnObservation still downgrades a no-change criterion when a change-verb command actually ran", () => {
  const verdict = { overall: "pass", criteria: [
    { criterion: "no changes were made to the record", status: "pass", evidence: "looks fine" }
  ] };
  const attempts = [{ command: "aux4 crm update --id 1 --field x", failed: false }];
  const out = requireOwnObservation(verdict, [], ["no changes were made to the record"], attempts);
  assert.equal(out.criteria[0].status, "unverifiable");
});

test("unverifiableOnlyAfterChange is true only when nothing failed, something remains unverifiable, and a change already succeeded (reply-decline-conflict)", () => {
  const change = [{ command: "google gmail send --to a --threadId t --body b", failed: false }];
  const noChangeYet = [{ command: "google gmail list --unread", failed: false }];
  const unverifiableAfterSend = { overall: "fail", criteria: [
    { criterion: "the calendar is checked", status: "unverifiable" },
    { criterion: "a reply is sent", status: "unverifiable" },
    { criterion: "answer criterion", status: "pass" }
  ] };
  const realFailure = { overall: "fail", criteria: [
    { criterion: "the meeting is moved to 16:00", status: "fail" },
    { criterion: "answer criterion", status: "pass" }
  ] };
  assert.equal(unverifiableOnlyAfterChange(unverifiableAfterSend, change), true);
  // calendar-reschedule: a real, actionable failure must still retry.
  assert.equal(unverifiableOnlyAfterChange(realFailure, change), false);
  // Nothing has changed yet: a retry can still do something new.
  assert.equal(unverifiableOnlyAfterChange(unverifiableAfterSend, noChangeYet), false);
  // Already passing: no reason to stop early via this rule.
  assert.equal(unverifiableOnlyAfterChange({ overall: "pass", criteria: [] }, change), false);
});

test("the fixed read-back lets calendar-cancel pass on the first round instead of retrying on a downgrade (HARN-034)", async () => {
  // Reproduces the calendar-cancel journey: a successful read, then a
  // successful delete, in one round. Before the fix, runReadBack's missing
  // "aux4" prefix meant checks.length was always 0, so both state criteria
  // were downgraded to unverifiable and a second, redundant round followed.
  const fake = makeFakeAux4(`
const args = process.argv.slice(2);
const command = args.join(" ");
if (command.includes("loop-plan.md")) {
  process.stdout.write(JSON.stringify({
    goal: "g",
    doneCriteria: [
      { text: "the meeting is cancelled on the calendar", kind: "state" },
      { text: "the meeting is deleted from the calendar", kind: "state" }
    ],
    steps: []
  }));
} else if (command.includes("loop-verify.md")) {
  const q = args[args.indexOf("--question") + 1] || "";
  const payload = JSON.parse(q.slice(q.indexOf("{")));
  const seen = payload.currentState ? payload.currentState.result : "";
  const gone = seen.includes('"items":[]');
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => ({ criterion: c.criterion, status: gone ? "pass" : "fail", evidence: seen })) }));
} else if (command === "calendar events list --query budget") {
  process.stdout.write('{"items":[]}');
}
`);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, (q, h) => {
      fs.writeFileSync(h, JSON.stringify({ messages: [
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: "calendar events list --query budget" } }] } },
        { role: "tool", tool_call_id: "c1", content: '{"items":[{"id":"evt-1"}]}' },
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "c2", name: "executeAux4", args: { command: "calendar events delete --eventId evt-1" } }] } },
        { role: "tool", tool_call_id: "c2", content: "" }
      ] }));
      return "cancelled and deleted it";
    });
    assert.equal(outcome.stopped, "pass");
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(outcome.verdict.checks, ["calendar events list --query budget"]);
  });
});

function spawnSyncBare(command) {
  return spawnSync("sh", ["-c", command], { encoding: "utf8" });
}

// --- HARN-035: same-round confirmation for a clearly requested action -------

function pendingConfirmFixture(label, nextCmd, firstCommand = "agent browser run --session 's1' --goal 'g' --field 'Full name=Jamie Fox'") {
  const confirmation = { action: label, target: label, emptyFields: [], next: nextCmd };
  return JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: firstCommand } }] } },
    { role: "tool", tool_call_id: "c1", content: JSON.stringify({ status: "needs-input", reason: "approval required", confirmation, next: nextCmd }) }
  ] });
}

test("pendingConfirmation reads the structured confirmation contract", () => {
  const next = "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'";
  const attempts = [{
    command: "agent browser run --session 's1' --goal 'g'",
    failed: false,
    result: JSON.stringify({
      status: "needs-input",
      reason: "approval needed",
      confirmation: { action: "Save", target: "Save — shipping details", emptyFields: ["Comment"], next }
    })
  }];
  const pending = pendingConfirmation(attempts);
  assert.equal(pending.label, "Save");
  assert.equal(pending.target, "Save — shipping details");
  assert.deepEqual(pending.emptyFields, ["Comment"]);
  assert.equal(pending.next, next);
  assert.equal(pendingConfirmation([{ command: "x --field 'confirm=yes'", failed: false, result: "ok" }]), null);
  // Legacy prose and a top-level next command do not form the structured contract.
  assert.equal(pendingConfirmation([{ command: "x", failed: false, result: JSON.stringify({ status: "needs-input", reason: '"Save" cannot be undone', next }) }]), null);
  assert.equal(pendingConfirmation([]), null);
});

test("pendingConfirmation survives blocked retries of its exact confirm command", () => {
  const next = "agent browser run --session 's1' --goal 'Save the contact' --field 'confirm=yes'";
  const pendingResult = JSON.stringify({
    status: "needs-input",
    confirmation: { action: "Save", target: "Save contact", emptyFields: [], next }
  });
  const attempts = [
    { command: "agent browser run --session 's1' --goal 'Save the contact'", failed: false, result: pendingResult },
    { command: next, failed: true, result: "Blocked by a confirmation hook" },
    { command: next, failed: true, result: "Repeated hook denial" }
  ];
  assert.equal(pendingConfirmation(attempts).next, next);
  assert.equal(pendingConfirmation([...attempts, {
    command: "agent browser find --url https://example.test --question 'find contact'",
    failed: true,
    result: "network error"
  }]), null, "an unrelated later failure must not revive an old confirmation");
  assert.equal(pendingConfirmation([...attempts.slice(0, 1), {
    command: next,
    failed: false,
    result: '{"status":"done"}'
  }]), null, "a successful confirmation must consume the pending contract");
});

test("isClearlyRequestedAction is strict: the request's own words must contain the SAME change verb as the pending action", () => {
  assert.equal(isClearlyRequestedAction("Save", "Save the shipping details for Jamie Fox."), true);
  // not requested at all -- no change verb in the request
  assert.equal(isClearlyRequestedAction("Save", "Look up the shipping details for Jamie Fox."), false);
  // ambiguous: the request DOES ask for a change, but a different one than the pending action --
  // this must ask too, never be treated as "requested" on a guess
  assert.equal(isClearlyRequestedAction("Save", "Send the shipping details to Jamie Fox."), false);
  assert.equal(isClearlyRequestedAction("", "Save it."), false);
});

test("composeRunNextQuestion tells the executor to run the pending next command now", () => {
  const q = composeRunNextQuestion({ next: "agent browser run --session 's1' --field 'confirm=yes'" });
  assert.match(q, /Run the next command now/);
  assert.match(q, /agent browser run --session 's1' --field 'confirm=yes'/);
});

test("composeNeedsConfirmationAnswer names the exact pending action and its reason", () => {
  const a = composeNeedsConfirmationAnswer({ label: "Save", reason: '"Save" cannot be undone, so the run stopped before it.' });
  assert.match(a, /Save/);
  assert.match(a, /confirmation/);
});

test("a clearly requested irreversible action is confirmed in the SAME round -- no retry (HARN-035)", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Save the shipping details for Jamie Fox." };
    const next = "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'";
    let modelCalls = 0;
    const seen = [];
    const outcome = await runLoop(options, history, (question, h) => {
      modelCalls++;
      assert.ok(question);
      fs.writeFileSync(h, pendingConfirmFixture("Save", next));
      return "It needs confirmation before saving.";
    }, "", async (command, h) => {
      seen.push({ command, gate: [...(options.gateDeny || [])] });
      assert.equal(command, next);
      appendExecutionResult(h, command, '{"status":"done","submitted":true}', "saved");
      return "Saved the shipping details.";
    });
    assert.equal(modelCalls, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].command, next);
    assert.deepEqual(seen[0].gate, []);
    assert.equal(outcome.stopped, "pass");
    // one round, not a retry: the loop never looped back for a second attempt.
    assert.equal(outcome.attempts, 1);
  });
});

test("monitored confirmation continuations advance two pending steps before verification", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Save the selected record.", hooksSupported: true, hooksFile: "fixed-hooks.json" };
    const next = "agent browser run --session 's1' --goal 'Save the selected record' --field 'confirm=yes'";
    const contracts = [
      { status: "needs-input", step: 1, confirmation: { action: "Save record", target: "record A", emptyFields: [], next } },
      { status: "needs-input", step: 2, confirmation: { action: "Save record", target: "record A", emptyFields: [], next } }
    ];
    const modelTurns = [];
    const dispatched = [];
    const outcome = await runLoop(options, history, (question, h) => {
      modelTurns.push(question);
      appendExecutionResult(h, "agent browser run --goal 'Save the selected record'", JSON.stringify(contracts[0]), "initial-pending");
      return { content: "A confirmation is pending.", stopReason: "confirmation" };
    }, "", async (command, h, _denied, _retry, _patterns) => {
      dispatched.push({ command, gate: [...(options.gateDeny || [])], hooksFile: options.hooksFile });
      assert.equal(command, next, "the controller dispatch receives the exact next string");
      if (dispatched.length === 1) {
        appendExecutionResult(h, command, JSON.stringify(contracts[1]), "step-2");
        return { content: "Confirmation step 2 is pending.", stopReason: "confirmation" };
      }
      appendExecutionResult(h, command, JSON.stringify({ status: "done", submitted: true, recordId: "record A" }), "done");
      return "The record was deleted.";
    });
    assert.equal(modelTurns.length, 1, "exact continuations do not request another model decision");
    assert.equal(dispatched.length, 2, "each fresh pending stage is dispatched once");
    assert.deepEqual(dispatched.map(call => call.gate), [[], []]);
    assert.deepEqual(dispatched.map(call => call.hooksFile), ["fixed-hooks.json", "fixed-hooks.json"], "normal before-hooks remain configured for every dispatch");
    assert.equal(outcome.stopped, "pass");
    assert.ok(outcome.metrics.rounds[0].verify, "verification occurs only after the explicit terminal result");
  });
});

test("a repeated identical pending confirmation stops without verification", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const next = "agent browser run --session 's1' --goal 'Save the selected record' --field 'confirm=yes'";
    const pending = JSON.stringify({ status: "needs-input", confirmation: { action: "Save record", target: "record A", emptyFields: [], next } });
    let modelCalls = 0;
    let dispatchCalls = 0;
    const outcome = await runLoop({ ...baseOptions(), request: "Save the selected record." }, history, (_question, h) => {
      modelCalls++;
      appendExecutionResult(h, "records save", pending, "pending-initial");
      return { content: "The same confirmation is still pending.", stopReason: "confirmation" };
    }, "", async (command, h) => {
      dispatchCalls++;
      assert.equal(command, next);
      appendExecutionResult(h, command, pending, `pending-${dispatchCalls}`);
      return { content: "The same confirmation is still pending.", stopReason: "confirmation" };
    });
    assert.equal(modelCalls, 1);
    assert.equal(dispatchCalls, 1, "the exact next is dispatched once, then an unchanged contract is bounded");
    assert.equal(outcome.stopped, "needs-confirmation");
    assert.equal(outcome.metrics.rounds[0].verify, undefined, "a pending action is never passed to the verifier as completed");
    assert.match(outcome.content, /has not been submitted/);
  });
});

test("a pending continuation stays blocked when the installed ai-agent lacks exact dispatch capability", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("no-dispatch-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const next = "records delete --recordId R-7 --field confirm=yes";
    let modelCalls = 0;
    const outcome = await runLoop({ ...baseOptions(), request: "Delete record R-7." }, history, (_question, h) => {
      modelCalls++;
      appendExecutionResult(h, "records delete --recordId R-7", JSON.stringify({
        status: "needs-input", confirmation: { action: "Delete record", target: "record R-7", emptyFields: [], next }
      }), "pending");
      return { content: "Confirmation is pending.", stopReason: "confirmation" };
    });
    assert.equal(modelCalls, 1);
    assert.equal(outcome.stopped, "needs-confirmation");
    assert.equal(outcome.metrics.rounds[0].verify, undefined);
    assert.match(outcome.content, /has not been submitted/);
  });
});

test("yielded unrequested actions ask, and yielded missing inputs never submit", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  await withAux4Bin(fake, async () => {
    const unrequestedHistory = tmpFile("unrequested-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
    const next = "agent browser run --session s1 --goal 'Save record' --field confirm=yes";
    let unrequestedCalls = 0;
    let unrequestedDispatches = 0;
    const unrequested = await runLoop({ ...baseOptions(), request: "Look up the selected record." }, unrequestedHistory, (question, h) => {
      unrequestedCalls++;
      appendExecutionResult(h, "agent browser run --goal 'Save record'", JSON.stringify({
        status: "needs-input", confirmation: { action: "Save record", target: "record A", emptyFields: [], next }
      }), "unrequested");
      return { content: "Waiting for approval.", stopReason: "confirmation" };
    }, "", async () => { unrequestedDispatches++; assert.fail("unrequested actions must not dispatch"); });
    assert.equal(unrequestedCalls, 1);
    assert.equal(unrequestedDispatches, 0);
    assert.equal(unrequested.stopped, "needs-confirmation");

    const missingHistory = tmpFile("missing-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
    let missingCalls = 0;
    let missingDispatches = 0;
    const missing = await runLoop({ ...baseOptions(), request: "Create a record." }, missingHistory, (question, h) => {
      missingCalls++;
      if (missingCalls === 1) {
        appendExecutionResult(h, "records create", JSON.stringify({ status: "needs-input", confirmation: {
          action: "Create record", target: "new record", emptyFields: ["Record name"], next: "records create --field confirm=yes"
        } }), "missing-field");
        return { content: "A required field is missing.", stopReason: "confirmation" };
      }
      assert.match(question, /Required fields still empty: Record name/);
      return "BLOCKED: the record name was not supplied or found.";
    }, "", async () => { missingDispatches++; assert.fail("missing fields must not dispatch"); });
    assert.equal(missingCalls, 2);
    assert.equal(missingDispatches, 0);
    assert.equal(missing.stopped, "blocked");
    assert.equal(extractAttemptLog(missingHistory).some(attempt => /confirm=yes/.test(attempt.command)), false);

    const readHistory = tmpFile("read-only-recovery-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
    let readCalls = 0;
    let readDispatches = 0;
    const readOnlyRecovery = await runLoop({ ...baseOptions(), request: "Create a record." }, readHistory, (question, h) => {
      readCalls++;
      if (readCalls === 1) {
        appendExecutionResult(h, "records create", JSON.stringify({ status: "needs-input", confirmation: {
          action: "Create record", target: "new record", emptyFields: ["Record name"], next: "records create --field confirm=yes"
        } }), "missing-before-read");
        return { content: "The record name is required.", stopReason: "confirmation" };
      }
      appendExecutionResult(h, "agent browser inspect --session s1", JSON.stringify({ status: "done", observations: { current: "No record name was shown." } }), "inspect-only");
      return "I inspected the current page, but it does not show a record name.";
    }, "", async () => { readDispatches++; assert.fail("read-only recovery cannot dispatch a pending write"); });
    assert.equal(readCalls, 2);
    assert.equal(readDispatches, 0);
    assert.equal(readOnlyRecovery.stopped, "needs-input", "inspection text is not an explicit cleared-field contract");
    assert.equal(extractAttemptLog(readHistory).some(attempt => /confirm=yes/.test(attempt.command)), false);

    const completedHistory = tmpFile("exact-continuation-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
    const exactNext = "records create --name Alpha --field confirm=yes";
    let completionCalls = 0;
    let completionDispatches = 0;
    const completedRecovery = await runLoop({ ...baseOptions(), request: "Create a record named Alpha." }, completedHistory, (question, h) => {
      completionCalls++;
      if (completionCalls === 1) {
        appendExecutionResult(h, "records create", JSON.stringify({ status: "needs-input", confirmation: {
          action: "Create record", target: "new record", emptyFields: ["Record name"], next: exactNext
        } }), "missing-before-submit");
        return { content: "The record name must be supplied before submission.", stopReason: "confirmation" };
      }
      assert.match(question, /Required fields still empty: Record name/);
      appendExecutionResult(h, exactNext, JSON.stringify({ status: "done", submitted: true, recordId: "record A" }), "exact-submit");
      return "Created the record.";
    }, "", async () => { completionDispatches++; assert.fail("the unresolved required field blocks continuation dispatch"); });
    assert.equal(completionCalls, 2);
    assert.equal(completionDispatches, 0);
    assert.equal(completedRecovery.stopped, "pass", "only the exact conclusive continuation clears the pending missing-input state");
    assert.ok(completedRecovery.metrics.rounds[0].verify);
  });
});

test("an irreversible action beyond the request stops and asks -- no retry (HARN-035)", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Look up the shipping details for Jamie Fox." };
    let calls = 0;
    let dispatches = 0;
    const outcome = await runLoop(options, history, (question, h) => {
      calls++;
      fs.writeFileSync(h, pendingConfirmFixture("Save", "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'"));
      return "It needs confirmation before saving.";
    }, "", async () => { dispatches++; assert.fail("an unrequested change must not dispatch"); });
    assert.equal(calls, 1);
    assert.equal(dispatches, 0);
    assert.equal(outcome.stopped, "needs-confirmation");
    assert.match(outcome.content, /Save/);
  });
});

test("an ambiguous case -- the request asks for a different change than the pending action -- also stops and asks, never confirms on a guess (HARN-035)", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Send the shipping details to Jamie Fox." };
    let calls = 0;
    let dispatches = 0;
    const outcome = await runLoop(options, history, (question, h) => {
      calls++;
      fs.writeFileSync(h, pendingConfirmFixture("Save", "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'"));
      return "It needs confirmation before saving.";
    }, "", async () => { dispatches++; assert.fail("a different requested action must not dispatch"); });
    assert.equal(calls, 1);
    assert.equal(dispatches, 0);
    assert.equal(outcome.stopped, "needs-confirmation");
  });
});

test("the check-values hook keeps applying to the same-round confirm follow-up (HARN-035 does not bypass HARN-030)", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Save the shipping details for Jamie Fox.", hooksSupported: true, hooksFile: "fixed-hooks.json" };
    const next = "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'";
    let modelCalls = 0;
    const seen = [];
    await runLoop(options, history, (_question, h) => {
      modelCalls++;
      fs.writeFileSync(h, pendingConfirmFixture("Save", next));
      return "needs confirmation";
    }, "", async (command, h) => {
      seen.push({ command, hooksFile: options.hooksFile, gate: [...(options.gateDeny || [])] });
      appendExecutionResult(h, command, '{"status":"done","submitted":true}', "saved");
      return "saved";
    });
    assert.equal(modelCalls, 1);
    // hooksFile (how the check-values before-hook is wired) is never touched by
    // this feature -- only gateDeny is opened for the one follow-up call.
    assert.equal(seen[0].command, next);
    assert.equal(seen[0].hooksFile, "fixed-hooks.json");
    assert.deepEqual(seen[0].gate, []);
  });
});

test("commandWords splits like executeAux4, with no shell expansion", () => {
  assert.deepEqual(commandWords(`google calendar events list --query "Budget review" --x '$HOME;rm'`),
    ["google", "calendar", "events", "list", "--query", "Budget review", "--x", "$HOME;rm"]);
  assert.deepEqual(commandWords(`a "say \\"hi\\"" b\\ c`), ["a", 'say "hi"', "b c"]);
  assert.equal(commandWords(`a "open`), null);
});

test("isClearlyRequestedAction matches the action's verb in any form, never a shared noun", () => {
  assert.equal(isClearlyRequestedAction("Confirm booking", "Book a trip to Tokyo. Review your choices before confirming."), true);
  assert.equal(isClearlyRequestedAction("Register", "Register for membership at the site"), true);
  assert.equal(isClearlyRequestedAction("Cancel order ord-0023", "Find the order from Elena and cancel it."), true);
  assert.equal(isClearlyRequestedAction("Delete order", "Find the order from Elena"), false);
  assert.equal(isClearlyRequestedAction("Send", "Draft a reply to Devon"), false);
  assert.equal(isClearlyRequestedAction("Submit", "Fill out the contact form"), false);
});

test("pendingConfirmation reads a complete structured contract from a truncated result", () => {
  const next = "aux4 agent browser run --session '7bb12572' --goal 'Fill out the form.' --field 'confirm=yes'";
  const result = JSON.stringify({
    status: "needs-input",
    confirmation: { action: "Save", target: "Save — shipping form", emptyFields: [], next },
    reason: "x".repeat(2000)
  }).slice(0, -2);
  const p = pendingConfirmation([{ command: "agent browser run --url http://x/shipping", result }]);
  assert.ok(p);
  assert.equal(p.label, "Save");
  assert.equal(p.next, next);
});

test("compactResult keeps the structured confirmation contract when a long field comes first", () => {
  const next = "aux4 agent browser run --field 'confirm=yes'";
  const big = JSON.stringify({
    status: "needs-input",
    confirmation: { action: "Save", target: "Save form", emptyFields: [], next },
    reason: "x".repeat(2000),
    stepsText: ["select \"Plan\" = Pro", "fill \"Comments\" = Hi"],
    steps: [{ a: 1 }, { b: 2 }]
  });
  const c = compactResult(big, 800);
  assert.ok(c.length <= 800);
  const parsed = JSON.parse(c);
  assert.deepEqual(parsed.confirmation, { action: "Save", target: "Save form", emptyFields: [], next });
  assert.deepEqual(parsed.stepsText, ['select "Plan" = Pro', 'fill "Comments" = Hi']);
  assert.deepEqual(parsed.steps, ["{1 fields}", "{1 fields}"]);
  assert.equal(compactResult("plain text " + "y".repeat(900), 800).length, 800);
});

test("compactResult keeps each result row's text from a list of objects", () => {
  const big = JSON.stringify({ question: "q", answered: false, reason: "r".repeat(1500), matches: [
    { text: "EchoBuds Lite | headphones | yes | 39.99", score: 0.95, location: { selector: "#a" } },
    { text: "BassWave X | headphones | yes | 27.75", score: 0.95, location: { selector: "#b" } }
  ] });
  const c = compactResult(big, 800);
  assert.match(c, /BassWave X \| headphones \| yes \| 27\.75/);
  assert.match(c, /EchoBuds Lite/);
});

test("isClearlyRequestedAction asks when the verb matches but the action's object does not", () => {
  assert.equal(isClearlyRequestedAction("Cancel order #123", "cancel my newsletter subscription"), false);
  assert.equal(isClearlyRequestedAction("Delete account", "delete the draft email"), false);
  assert.equal(isClearlyRequestedAction("Cancel order ord-1", "find the order from the customer and cancel it"), false);
  assert.equal(isClearlyRequestedAction("Submit survey", "fill out the survey and submit it"), true);
  assert.equal(isClearlyRequestedAction("Save", "save the address"), true);
});

test("addDenyPatterns attaches a reason so a blocked command says what to use instead", () => {
  const policy = JSON.parse(addDenyPatterns("{}", ["browser", "browser *"], "use agent browser run instead"));
  assert.deepEqual(policy.deny, [{ executeAux4: ["browser", "browser *"], reason: "use agent browser run instead" }]);
  assert.deepEqual(JSON.parse(addDenyPatterns("{}", ["x *"])).deny, [{ executeAux4: ["x *"] }]);
});

test("onlyAnswerFailed is false when the tool reported its own work unfinished", async () => {
  const { isConclusiveAttempt } = await import("../lib/agent-loop.mjs");
  const plan = { doneCriteria: ["the reply gives the name"], stateCriteria: [] };
  const verdict = { overall: "fail", criteria: [{ criterion: "the reply gives the name", status: "fail", evidence: "not given" }] };
  const unfinished = [{ command: "agent browser run --url x --goal g", failed: false, source: '{"status": "incomplete", "reason": "nothing chosen"}' }];
  assert.equal(isConclusiveAttempt(unfinished[0]), false);
  assert.equal(onlyAnswerFailed(plan, verdict, unfinished), false);
  const finished = [{ command: "agent browser find --url x --question q", failed: false, source: '{"answered": true, "matches": ["A | 9.99"]}' }];
  assert.equal(onlyAnswerFailed(plan, verdict, finished), true);
});

test("a specific item is only confirmed when the request says which item", () => {
  assert.equal(isClearlyRequestedAction("Cancel order ord-0001", "Please cancel my order at http://shop.test:7400/orders."), false);
  assert.equal(isClearlyRequestedAction("Delete address addr-2", "Delete my address at http://shop.test:7400/addresses"), false);
  assert.equal(isClearlyRequestedAction("Cancel order ord-0023", "Cancel order ord-0023 please"), true);
  assert.equal(isClearlyRequestedAction("Cancel order ord-0023", "Find the order from Dana Ruiz for $12.40 and cancel it"), true);
  assert.equal(isClearlyRequestedAction("Delete address addr-2", "Delete the Denver address for Sam Lee"), true);
});


test("runAux4Monitored ignores completed refusals from a previous invocation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-watch-"));
  const bin = path.join(dir, "aux4");
  const history = path.join(dir, "history.json");
  const refusal = "Error executing tool: Aborting: the same action has returned the same result 4 times. The agent is not making progress.";
  fs.writeFileSync(history, JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "old", name: "executeAux4", args: { command: "records list" } }] } },
    { role: "tool", tool_call_id: "old", content: refusal }
  ] }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
setTimeout(() => {
  const file = ${JSON.stringify(history)};
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.messages.push(
    { role: 'assistant_with_tool', content: { tool_calls: [{ id: 'new', name: 'executeAux4', args: { command: 'records get --help' } }] } },
    { role: 'tool', tool_call_id: 'new', content: 'Use --recordId' }
  );
  fs.writeFileSync(file, JSON.stringify(data));
  process.stdout.write('recovered');
}, 180);
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const result = await runAux4Monitored([], history, { pollInterval: 25 });
    assert.equal(result.ok, true);
    assert.equal(result.noProgress, false);
    assert.equal(result.stdout, "recovered");
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("metrics include local parameter-reference lookups without inventing model tool calls", () => {
  const file = tmpFile("parameter-help-history.json", JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "bad-flag", name: "executeAux4", args: { command: "records get --id r7" } }] } },
    { role: "tool", tool_call_id: "bad-flag", content: "Error executing command: Unknown parameter --id\n\nLocal command parameter reference (--help; no action retried):\n--recordId <arg>" }
  ] }));
  const stats = historyStats(file);
  assert.equal(stats.help, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.modelCalls, 1);
  assert.equal(stats.failed, 1);
});


test("a retry repeats observed facts in context, without failed, pending, or documentation evidence", () => {
  const fact = '{"id":"r7","owner":"Morgan","status":"inactive"}';
  const attempts = [
    { command: "records get --recordId r7", source: fact },
    { command: "records get --recordId r7 --format full", source: fact },
    { command: "records get --recordId r8", source: "pending-secret", completed: false },
    { command: "records list --help", source: "example-secret" },
    { command: "records find", source: "failed-secret", failed: true }
  ];
  const q = composeDiagnoseQuestion({ goal: "archive inactive records" }, { criteria: [] }, attempts);
  const evidence = q.split("Facts already observed from successful reads")[1].split("What was attempted")[0];
  assert.equal(evidence.split(fact).length - 1, 1);
  assert.doesNotMatch(evidence, /pending-secret|example-secret|failed-secret/);
  assert.match(q, /Reuse facts from successful reads/);
});


test("large first-group help cannot hide another group's read commands", async () => {
  const fake = makeFakeAux4(`const args = process.argv.slice(2);
const group = args.slice(0, -1).join(' ');
if (group === 'records events') console.log('events\\n  list\\n  List events.\\n' + '    long parameter documentation\\n'.repeat(200));
else if (group === 'correspondence') console.log('correspondence\\n  list\\n  List message IDs.\\n  get\\n  Read a full message by identifier.\\n    --recordId <arg>\\n  download\\n  Download one attachment.');
`);
  await withAux4Bin(fake, async () => {
    const text = describeFoundCommands([
      { command: "aux4 records events list", description: "List events." },
      { command: "aux4 correspondence", description: "The correspondence command group." }
    ]);
    assert.match(text, /correspondence get: Read a full message by identifier/);
    assert.match(text, /correspondence download: Download one attachment/);
    assert.ok(text.indexOf('correspondence get:') < text.indexOf('Parameter details for records events'));
    assert.ok(text.length < 6500);
  });
});


test("metrics count unusable provider requests as protocol errors and actual model calls", () => {
  const file = tmpFile('protocol-history.json', JSON.stringify({messages:[
    {role:'user',content:'The provider returned an unusable tool request. No action was run.'},
    {role:'user',content:'The provider returned an unusable tool request. Repair the syntax.'},
    {role:'assistant',content:'The provider returned an unusable tool request three times in a row; the task was not completed.'}
  ]}));
  const stats = historyStats(file);
  assert.equal(stats.modelCalls, 3);
  assert.equal(stats.protocolErrors, 3);
  assert.equal(stats.emptyReplies, 0);
  assert.equal(stats.toolCalls, 0);
});


test("metrics also count explicit backend protocol-error feedback", () => {
  const file = tmpFile('backend-protocol-history.json', JSON.stringify({messages:[
    {role:'assistant_with_tool',content:{tool_calls:[{id:'invalid',name:'__tool_protocol_error__',args:{error:'No function provided.'}}]}},
    {role:'tool',tool_call_id:'invalid',content:'Error: generated tool request could not be parsed. No action was run.'}
  ]}));
  const stats = historyStats(file);
  assert.equal(stats.modelCalls, 1);
  assert.equal(stats.protocolErrors, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.emptyReplies, 0);
});


test("requested submission with missing required values gets bounded recovery, never automatic confirmation", async () => {
  const fake=planVerifyFake({verifyStatus:'pass'});
  const history=tmpFile('history.json',JSON.stringify({messages:[],tokenUsage:{}}));
  await withAux4Bin(fake,async()=>{
    const next="agent forms run --session s1 --field confirm=yes";
    const questions=[];
    const result=await runLoop({...baseOptions(),request:'Save the application for Pat, pat@example.net.'},history,(question,h)=>{
      questions.push(question);
      if(questions.length===1){
        const data=JSON.parse(pendingConfirmFixture('Save',next,'agent forms run --goal apply'));
        const contract=JSON.parse(data.messages[1].content);
        contract.confirmation.emptyFields=['Badge number'];
        data.messages[1].content=JSON.stringify(contract);
        fs.writeFileSync(h,JSON.stringify(data));
        return 'The tool is waiting.';
      }
      assert.match(question,/not permission to submit/);
      assert.match(question,/pat@example.net/);
      assert.doesNotMatch(question,/Run the next command now/);
      return 'BLOCKED: Badge number is unavailable.';
    });
    assert.equal(questions.length,2);
    assert.equal(result.stopped,'blocked');
    assert.equal(result.attempts,1);
    assert.match(result.content,/Badge number/);
  });
});


test("supplied data can clear a missing field before same-round confirmation",async()=>{
  const fake=planVerifyFake({verifyStatus:'pass'});
  const history=tmpFile('history.json',JSON.stringify({messages:[],tokenUsage:{}}));
  await withAux4Bin(fake,async()=>{
    const next="agent forms run --session s1 --field confirm=yes";
    const questions=[];
    let dispatches=0;
    const result=await runLoop({...baseOptions(),request:'Save the application using badge B7.'},history,(question,h)=>{
      questions.push(question);
      if(questions.length===1){
        const data=JSON.parse(pendingConfirmFixture('Save',next,'agent forms run --goal apply'));
        const contract=JSON.parse(data.messages[1].content);contract.confirmation.emptyFields=['Badge number'];
        data.messages[1].content=JSON.stringify(contract);fs.writeFileSync(h,JSON.stringify(data));
        return 'Waiting for a field.';
      }
      appendExecutionResult(h,'agent forms run --field badge=B7',JSON.stringify({status:'needs-input',confirmation:{action:'Save',target:'Save',emptyFields:[],next}}),'field-resolved');
      return 'Ready to save.';
    },"",async(command,h)=>{
      dispatches++;
      assert.equal(command,next);
      appendExecutionResult(h,command,'{"status":"done","submitted":true}','saved');
      return 'Saved.';
    });
    assert.equal(questions.length,2);
    assert.equal(dispatches,1);
    assert.match(questions[1],/badge B7/);
    assert.equal(result.stopped,'pass');
    assert.equal(result.attempts,1);
  });
});


test("a question or help call cannot hide an unresolved action guard",()=>{
  const guard={command:'records update --recordId missing',failed:true,source:'ACTION_CHECK_EVIDENCE_REQUIRED: read the record first'};
  const ask={command:'askUser {"question":"What is the id?"}',failed:false,source:'Non-interactive session'};
  assert.equal(unresolvedActionGuard([guard,ask]),guard);
  assert.equal(unresolvedActionGuard([guard,{command:'records --help',source:'documentation'},ask]),guard);
  assert.equal(unresolvedActionGuard([guard,{command:'records list',source:'[]'}]),null);
  assert.equal(unresolvedActionGuard([guard,{command:'records update --recordId r7',source:'done'}]),null);
  assert.equal(unresolvedActionGuard([guard,{command:'records list',failed:true,source:'Permission denied'}]),guard);
  assert.equal(unresolvedActionGuard([guard,{command:'askUser',declined:true,source:'User aborted'}]),null);
});

test("a non-interactive question after a guard still gets same-round lookup recovery",async()=>{
  const fake=planVerifyFake({verifyStatus:'pass'});
  const history=tmpFile('history.json',JSON.stringify({messages:[],tokenUsage:{}}));
  await withAux4Bin(fake,async()=>{
    let calls=0;
    const result=await runLoop(baseOptions(),history,(question,h)=>{
      calls++;
      if(calls===1){
        fs.writeFileSync(h,JSON.stringify({messages:[
          {role:'assistant_with_tool',content:{tool_calls:[{id:'one',name:'executeAux4',args:{command:'records update --recordId unknown'}}]}},
          {role:'tool',tool_call_id:'one',content:'Blocked by hook: ACTION_CHECK_EVIDENCE_REQUIRED: Read records list --query <text> first.'},
          {role:'assistant_with_tool',content:{tool_calls:[{id:'two',name:'askUser',args:{question:'What is the record id?'}}]}},
          {role:'tool',tool_call_id:'two',content:'Non-interactive session detected (no TTY).'}
        ]}));
        return 'I need the record id from you.';
      }
      assert.match(question,/Unresolved guard and available lookup contract/);
      assert.match(question,/records list --query/);
      const data=JSON.parse(fs.readFileSync(h,'utf8'));
      data.messages.push(
        {role:'assistant_with_tool',content:{tool_calls:[{id:'three',name:'executeAux4',args:{command:'records list --query target'}}]}},
        {role:'tool',tool_call_id:'three',content:'{"items":[{"id":"r7"}]}'},
        {role:'assistant_with_tool',content:{tool_calls:[{id:'four',name:'executeAux4',args:{command:'records update --recordId r7'}}]}},
        {role:'tool',tool_call_id:'four',content:'{"status":"done"}'}
      );
      fs.writeFileSync(h,JSON.stringify(data));return 'Updated.';
    });
    assert.equal(calls,2);assert.equal(result.attempts,1);assert.equal(result.stopped,'pass');
  });
});

test("an unsubmitted workflow is not denied as already completed on retry",async()=>{
  const fake=planVerifyFake({verifyStatus:'fail'});
  const history=tmpFile('history.json',JSON.stringify({messages:[],tokenUsage:{}}));
  const command='agent browser run --url https://example.test/apply --goal apply';
  await withAux4Bin(fake,async()=>{
    let calls=0;
    const result=await runLoop(baseOptions(),history,(_question,h,denied,_lookFirst,patterns)=>{
      calls++;
      if(calls===1){
        fs.writeFileSync(h,JSON.stringify({messages:[
          {role:'assistant_with_tool',content:{tool_calls:[{id:'one',name:'executeAux4',args:{command}}]}},
          {role:'tool',tool_call_id:'one',content:'{"status":"needs-input","submitted":false,"needsInput":{"kind":"missing","field":{"label":"Badge number"}}}'}
        ]}));return 'The workflow is waiting for data.';
      }
      assert.ok(!denied.includes(command));
      assert.deepEqual(patterns,[]);
      return 'BLOCKED: Badge number is unavailable.';
    });
    assert.equal(calls,2);assert.equal(result.stopped,'blocked');
  });
});


test("before and after provenance agree on named boolean choices",()=>{
  const request='Enable Release notices and disable Usage reports.';
  const fields=['Release notices=checked','Usage reports=unchecked'];
  assert.deepEqual(unsourcedFieldValues(fields,[],request),[]);
  assert.deepEqual(unsourcedValues([{command:'agent forms run '+fields.map(value=>'--field "'+value+'"').join(' '),source:'{}'}],request),[]);
  assert.equal(unsourcedValues([{command:'agent forms run --field "Manager override=yes"',source:'{}'}],request).length,1);
});

test("unexecuted, failed, documentation and goal-echo values are not provenance",()=>{
  const command='agent forms run --field "Code=A7"';
  assert.deepEqual(unsourcedValues([{command,failed:true,source:'Blocked by hook'}],'Save the form'),[]);
  assert.deepEqual(unsourcedValues([{command,completed:false}],'Save the form'),[]);
  for(const prior of [
    {command:'records get',failed:true,source:'Error: A7'},
    {command:'records get --help',source:'Example code A7'},
    {command:'agent forms run --goal "type code A7"',source:'{"fromGoal":{"Code":"A7"}}'}
  ])assert.equal(unsourcedFieldValues(['Code=A7'],[prior],'Save the form').length,1);
});


test("options and page overviews are not assigned field values",()=>{
  const options=[{command:'forms list',source:'{"options":{"Category":["Gold","Silver"]}}'}];
  assert.deepEqual(availableFieldChoices(options),[{label:'Category',value:'Gold'},{label:'Category',value:'Silver'}]);
  assert.equal(unsourcedFieldValues(['Category=Gold'],options,'Use the category assigned on file.').length,1);
  assert.deepEqual(unsourcedFieldValues(['Category=Gold'],options,'Choose any available Category.'),[]);
  assert.equal(unsourcedFieldValues(['Category=Platinum'],options,'Choose any available Category.').length,1);
  const assigned=[...options,{command:'records get',source:'{"Category":"Silver"}'}];
  assert.deepEqual(unsourcedFieldValues(['Category=Silver'],assigned,'Use the category assigned on file.'),[]);
  assert.equal(unsourcedFieldValues(['Category=Gold'],[{command:'agent browser run',source:'{"status":"done","observations":{"current":"Category (Gold or Silver)"}}'}],'Use the category assigned on file.').length,1);
  assert.equal(fieldEvidenceText('{"answered":false,"matches":[{"text":"Gold"}]}'),'');
  assert.equal(fieldEvidenceText('The assigned category is Gold.','agent ask --request lookup'),'');
  assert.equal(fieldEvidenceText('{"status":"done","observations":{"current":"Gold"'), '');
  assert.match(fieldEvidenceText('{"answered":true,"matches":[{"text":"Assigned category Silver"}]}'),/Silver/);
  const ranked = fieldEvidenceText(JSON.stringify({
    answered: true,
    matches: [],
    pageEvidence: {
      coverage: "ranked-top-k", complete: false, limitPerPage: 2,
      pages: [{ page: 3, url: "https://example.test/records?page=3", matches: [{
        text: "rec-17 | Rowan Lee | selected",
        block: { id: "row-17" },
        location: { url: "https://example.test/records?page=3", selector: "#row-17" }
      }] }]
    }
  }), "agent browser find --question records");
  assert.match(ranked, /rec-17 \| Rowan Lee \| selected/);
  assert.match(ranked, /ranked-top-k/);
  assert.match(ranked, /"complete":false/);
  assert.match(ranked, /sourceUrl/);
  assert.doesNotMatch(ranked, /"actions"|"score"/);
  for (const malformed of [
    { coverage: "ranked-top-k", complete: true, limitPerPage: 2, pages: [] },
    { coverage: "ranked-top-k", complete: false, limitPerPage: 0, pages: [] },
    { coverage: "ranked-top-k", complete: false, limitPerPage: 2, pages: [{ page: 1, url: "x", matches: [{ id: "row-17" }] }] }
  ]) {
    assert.doesNotMatch(fieldEvidenceText(JSON.stringify({ answered: true, matches: [], pageEvidence: malformed }), "agent browser find"), /rec-17/);
  }
});


test("explicitly preserved fields cannot be overwritten using identity text", () => {
  const attempts = [{command: "contacts get", source: '{"name":"Rowan Lee","postalCode":"44001"}'}];
  assert.equal(unsourcedFieldValues(["Name=Rowan"], attempts, "Update the phone for Rowan. Preserve the name.")[0].preserved, true);
  assert.deepEqual(unsourcedFieldValues(["Name=Rowan Lee"], attempts, "Update the phone for Rowan. Preserve the name."), []);
  assert.equal(unsourcedFieldValues(["Postal code=44002"], attempts, "44002 is my reference. Keep postal code unchanged.")[0].preserved, true);
  assert.deepEqual(unsourcedFieldValues(["Postal code=44002"], attempts, "Change postal code to 44002."), []);
});


test("page delegation retains discovery of independent prerequisite capabilities", async () => {
  const fake = makeFakeAux4(`
const args=process.argv.slice(2);
if(args.includes('pkger'))console.log(JSON.stringify([{command:'aux4 directory read',description:'Read directory entries'},{command:'aux4 forms click',description:'Click a control'},{command:'aux4 agent forms run',description:'Act on a form'}]));
else if(args.includes('--help'))console.log(args.join(' '));
`);
  await withAux4Bin(fake, async () => {
    const reference=executionCommandReference('Fill the page https://example.test/application using a directory entry.',{lookFor:['read directory entries']},[{via:'agent:forms',group:'forms',urlTasks:true,entrypoints:['run','find']}]);
    assert.match(reference,/agent forms run/);
    assert.match(reference,/directory read/);
    assert.doesNotMatch(reference,/forms click/);
    assert.ok(reference.indexOf('agent forms run') < reference.indexOf('directory read'));
  });
});


test("failed writes cannot be certified as completed state changes", () => {
  const criterion="The notification was sent.";
  const verdict={overall:"pass",criteria:[{criterion,status:"pass",evidence:"The assistant said it was sent."}]};
  const plan={stateCriteria:[criterion]};
  const reads=[{command:"messages list",source:'{"items":[{"id":"r7"}]}'}];
  const failed={command:"messages send --to recipient@example.test",failed:true,source:"Blocked by hook: ACTION_CHECK_SCOPE_DENIED"};
  assert.equal(applyExecutionProof(verdict,plan,[...reads,failed]).overall,"fail");
  assert.equal(applyExecutionProof(verdict,plan,[...reads,{...failed,failed:false,completed:false}]).overall,"fail");
  assert.equal(applyExecutionProof(verdict,plan,[...reads,failed,{command:"messages send --to recipient@example.test",source:'{"id":"sent7"}'}]).overall,"pass");
  assert.equal(applyExecutionProof(verdict,{stateCriteria:[]},[...reads,failed]).overall,"pass");
  assert.equal(applyExecutionProof(verdict,{stateCriteria:["No notification was sent."]},[...reads,failed]).overall,"pass");
  assert.equal(applyExecutionProof(verdict,plan,reads).overall,"pass");
});

test("scoped operation receipts and observations have separate outcome proof", () => {
  const criterion = "The requested record is deleted.";
  const plan = { stateCriteria: [criterion] };
  const assessment = { overall: "pass", criteria: [{ criterion, status: "pass", evidence: "The action completed.", basis: "actionResult", relation: "supports", claim: "absence", coverage: "complete" }] };
  const receipt = { command: "records delete --id r1", source: '{"status":"done","scopedOperation":{"status":"activated","goalVerified":false}}' };
  assert.equal(isConclusiveAttempt(receipt), true, "substep completion semantics stay unchanged");
  assert.equal(applyExecutionProof(assessment, plan, [receipt]).criteria[0].status, "unverifiable");

  const observedInSameCall = { ...receipt, source: '{"status":"done","scopedOperation":{"status":"activated","goalVerified":false},"observations":{"current":"Record Alpha Deleted; Record Beta Active"}}' };
  assert.equal(applyExecutionProof(assessment, plan, [observedInSameCall]).criteria[0].status, "unverifiable", "actionResult remains a receipt basis");
  const sameCallCurrentState = { output: observedInSameCall.source, command: observedInSameCall.command };
  const sameCallAssessment = { ...assessment, criteria: [{ ...assessment.criteria[0], basis: "currentState" }] };
  assert.equal(applyExecutionProof(sameCallAssessment, plan, [observedInSameCall], sameCallCurrentState).criteria[0].status, "pass");
  const staleObservation = { output: '{"scopedOperation":{"goalVerified":false},"observations":{"firstObserved":"Record Alpha active"}}', command: receipt.command };
  assert.equal(applyExecutionProof(sameCallAssessment, plan, [receipt], staleObservation).criteria[0].status, "unverifiable");

  const trueReceipt = { command: "records delete --id r1", source: '{"status":"done","deleted":true}' };
  const contradicted = { ...assessment, criteria: [{ ...assessment.criteria[0], basis: "currentState", relation: "contradicts", claim: "absence", coverage: "partial", evidence: "The target remains in the current list." }] };
  const result = applyExecutionProof(contradicted, plan, [trueReceipt], { output: '{"items":[{"id":"r1","status":"active"}]}' });
  assert.equal(result.criteria[0].status, "fail");
  const conflictingAnnotations = { ...assessment, criteria: [{ ...assessment.criteria[0], basis: "answer", relation: "contradicts", claim: "absence", coverage: "partial" }] };
  assert.equal(applyExecutionProof(conflictingAnnotations, plan, [trueReceipt]).criteria[0].status, "fail");
});

test("absence needs complete coverage while an observed match proves presence", () => {
  const absent = "The requested record is absent.";
  const present = "The requested record is present.";
  const plan = { stateCriteria: [absent, present] };
  const verdict = {
    overall: "pass",
    criteria: [
      { criterion: absent, status: "pass", evidence: "No match returned.", basis: "actionResult", relation: "supports", claim: "absence", coverage: "complete" },
      { criterion: present, status: "pass", evidence: "Matching row observed.", basis: "actionResult", relation: "supports", claim: "presence", coverage: "complete" }
    ]
  };
  const rankedNoMatch = { command: "records search", source: '{"provider":"ranked","answered":0.2,"candidates":12,"matches":[{"score":0.9,"text":"another record"}]}' };
  assert.equal(applyExecutionProof({ overall: "pass", criteria: [verdict.criteria[0]] }, { stateCriteria: [absent] }, [rankedNoMatch]).criteria[0].status, "unverifiable");
  const browserFindMiss = { command: "agent browser find", source: '{"question":"find the requested record","answered":false,"matches":[],"provider":"mock","blocks":0}' };
  assert.equal(applyExecutionProof({ overall: "pass", criteria: [verdict.criteria[0]] }, { stateCriteria: [absent] }, [browserFindMiss]).criteria[0].status, "unverifiable");
  const rankedMatch = { command: "records search", source: '{"provider":"ranked","answered":0.99,"candidates":12,"matches":[{"score":0.99,"text":"requested record"}]}' };
  assert.equal(applyExecutionProof({ overall: "pass", criteria: [verdict.criteria[1]] }, { stateCriteria: [present] }, [rankedMatch]).criteria[0].status, "pass");

  const completeScopedList = { command: "records list", source: '{"sourceMetadata":{"coverage":"complete","scope":"list"},"items":[]}' };
  assert.equal(applyExecutionProof({ overall: "pass", criteria: [verdict.criteria[0]] }, { stateCriteria: [absent] }, [completeScopedList]).criteria[0].status, "pass");
  const inspectPartial = { command: "agent browser inspect", source: '{"scope":"current-rendered-page","coverage":"partial-extracted-blocks","completeWithinScope":false,"blocks":[]}' };
  assert.equal(applyExecutionProof({ overall: "pass", criteria: [verdict.criteria[0]] }, { stateCriteria: [absent] }, [inspectPartial]).criteria[0].status, "unverifiable");
  const incidentalRecordField = { command: "records get", source: '{"id":"r1","truncated":true}' };
  assert.equal(applyExecutionProof({ overall: "pass", criteria: [verdict.criteria[0]] }, { stateCriteria: [absent] }, [incidentalRecordField]).criteria[0].status, "pass");
});

test("read-only and no-change state assessments retain their pass path", () => {
  const criterion = "No changes were made to the records.";
  const verdict = { overall: "pass", criteria: [{ criterion, status: "pass", evidence: "No write action ran.", basis: "actionResult", relation: "supports", claim: "other" }] };
  assert.equal(applyExecutionProof(verdict, { stateCriteria: [criterion] }, []).overall, "pass");
  const readOnly = "The result lists the protected record.";
  assert.equal(applyExecutionProof({ overall: "pass", criteria: [{ criterion: readOnly, status: "pass", evidence: "Present.", basis: "currentState", relation: "supports", claim: "presence" }] }, { stateCriteria: [readOnly] }, []).overall, "pass");
});

test("runVerify reuses one readback for every criterion and missing criteria stay fail-closed", async () => {
  const absent = "The target record is absent from the records list.";
  const present = "The protected record is present in the records list.";
  const fake = makeFakeAux4(`
const args=process.argv.slice(2), command=args.join(" ");
if(command.includes("loop-verify.md")){
  const q=args[args.indexOf("--question")+1]||"", payload=JSON.parse(q.slice(q.indexOf("{")));
  const results=payload.criteria.map((c,i)=>({criterion:c.criterion,status:"pass",evidence:"Current facts assessed.",basis:c.kind==="state"?"currentState":"answer",relation:"supports",claim:i===0?"absence":i===1?"presence":"other",coverage:"complete"}));
  process.stdout.write(JSON.stringify({results}));
} else if(command==="records list") process.stdout.write('{"items":[{"name":"Protected"}],"complete":true}');
`);
  const criteria = [absent, present, COVERAGE_CRITERION, HONESTY_CRITERION, AGREEMENT_CRITERION];
  const plan = { doneCriteria: [absent, present], stateCriteria: [absent, present] };
  const attempts = [{ tool: "executeAux4", command: "records list", source: '{"items":[{"name":"Protected"}],"complete":true}', failed: false }];
  await withAux4Bin(fake, async () => {
    const result = runVerify(baseOptions(), plan, "done", attempts);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0], "records list");
    assert.equal(result.criteria.length, criteria.length);
    assert.deepEqual(result.criteria.slice(0, 2).map(c => c.basis), ["currentState", "currentState"]);
    assert.deepEqual(result.criteria.slice(0, 2).map(c => c.status), ["pass", "pass"]);
  });

  const omitFake = makeFakeAux4(`
const args=process.argv.slice(2), command=args.join(" ");
if(command.includes("loop-verify.md")){
  const q=args[args.indexOf("--question")+1]||"", payload=JSON.parse(q.slice(q.indexOf("{")));
  const results=payload.criteria.filter(c=>c.criterion!=="The protected record is present in the records list.").map(c=>({criterion:c.criterion,status:"pass",evidence:"assessed",basis:c.kind==="state"?"currentState":"answer",relation:"supports",claim:"other"}));
  process.stdout.write(JSON.stringify({results}));
} else if(command==="records list") process.stdout.write('{"items":[{"name":"Protected"}],"complete":true}');
`);
  await withAux4Bin(omitFake, async () => {
    const result = runVerify(baseOptions(), plan, "done", attempts);
    assert.equal(result.criteria.find(c => c.criterion === present).status, "unverifiable");
  });

  const staleFake = makeFakeAux4(`
const args=process.argv.slice(2), command=args.join(" ");
if(command.includes("loop-verify.md")){
  const q=args[args.indexOf("--question")+1]||"", payload=JSON.parse(q.slice(q.indexOf("{")));
  const basis=payload.currentState?"currentState":"actionResult";
  process.stdout.write(JSON.stringify({results:payload.criteria.map(c=>({criterion:c.criterion,status:"pass",evidence:"assessed",basis,relation:"supports",claim:"other"}))}));
}
`);
  const earlierObservation = { tool: "executeAux4", command: "agent browser run --goal delete target", source: '{"status":"done","scopedOperation":{"goalVerified":false},"observations":{"current":"Target is still active."}}' };
  const laterMutation = { tool: "executeAux4", command: "records update --id r1", source: '{"status":"done","updated":true}' };
  await withAux4Bin(staleFake, async () => {
    const result = runVerify(baseOptions(), plan, "done", [earlierObservation, laterMutation]);
    assert.equal(result.criteria[0].status, "unverifiable", "an earlier current observation cannot be relabeled as fresh after a later mutation");
  });
});


test("an unexecuted change cannot leak a false success claim into the final answer", () => {
  const verdict={executionEvidenceMissing:true};
  const failed={command:"messages send",failed:true,source:"Blocked by hook"};
  assert.match(executionProofContent("I sent the notification.",verdict,[failed]),/was not completed/);
  assert.doesNotMatch(executionProofContent("I sent the notification.",verdict,[failed]),/I sent/);
  assert.equal(executionProofContent("I sent the notification.",verdict,[failed,{command:"messages send",source:'{"id":"sent7"}'}]),"I sent the notification.");
  const submitted={command:"agent browser run",source:'{"status":"needs-input","submitted":true}'};
  assert.equal(executionProofContent("A change was saved; a later step needs input.",verdict,[submitted]),"A change was saved; a later step needs input.");
});

test("terminal evidence summary keeps verified partial outcomes and suppresses unverified executor claims", () => {
  const removed = "The selected record is absent from the records list.";
  const protectedRecord = "The protected record remains in the records list.";
  const answerFact = "The report figure is 500 dollars.";
  const plan = { stateCriteria: [removed, protectedRecord], doneCriteria: [removed, protectedRecord, answerFact] };
  const verdict = { overall: "fail", criteria: [
    { criterion: removed, status: "unverifiable", evidence: "The action ended on an intermediate page." },
    { criterion: protectedRecord, status: "pass", evidence: "The current list contains the protected record." },
    { criterion: answerFact, status: "pass", evidence: "$500 was present in the report." },
    { criterion: COVERAGE_CRITERION, status: "pass", evidence: "The answer mentioned both outcomes." },
    { criterion: HONESTY_CRITERION, status: "unverifiable", evidence: "The requested change was not verified." },
    { criterion: AGREEMENT_CRITERION, status: "unverifiable", evidence: "The claim is unsupported." }
  ] };
  const summary = composeEvidenceSummary("The selected record was deleted; the protected record remains. Done.", verdict, plan);
  assert.match(summary, new RegExp(`Verified: ${protectedRecord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(summary, new RegExp(`Not confirmed: ${removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(summary, /Verified answer fact: \$500 was present in the report/);
  assert.doesNotMatch(summary, /was deleted|Done\./);
  assert.match(summary, /Not fully confirmed/);
  assert.doesNotMatch(summary, /The final answer accurately describes what the actions actually did/);
});

test("evidence summary preserves fully verified read-only answers byte-for-byte", () => {
  const criterion = "The result lists the requested item.";
  const plan = { stateCriteria: [criterion], doneCriteria: [criterion] };
  const answer = "Here is the requested item, including its verified details.\n";
  const verdict = { overall: "pass", criteria: [
    { criterion, status: "pass" },
    { criterion: COVERAGE_CRITERION, status: "pass" },
    { criterion: HONESTY_CRITERION, status: "pass" },
    { criterion: AGREEMENT_CRITERION, status: "pass" }
  ] };
  assert.equal(composeEvidenceSummary(answer, verdict, plan), answer);
});

test("evidence summary catches coverage and appended guard failures without exposing internal labels", () => {
  const state = "The requested record is present.";
  const answerFact = "The report includes the requested total.";
  const plan = { stateCriteria: [state], doneCriteria: [state, answerFact] };
  const base = [
    { criterion: state, status: "pass" },
    { criterion: answerFact, status: "pass", evidence: "The report shows a total of $500." },
    { criterion: HONESTY_CRITERION, status: "pass" },
    { criterion: AGREEMENT_CRITERION, status: "pass" }
  ];
  const coverage = composeEvidenceSummary("Everything requested is complete.", {
    overall: "fail", criteria: [...base, { criterion: COVERAGE_CRITERION, status: "fail" }]
  }, plan);
  assert.match(coverage, /Verified: The requested record is present/);
  assert.match(coverage, /Verified answer fact: The report shows a total of \$500/);
  assert.match(coverage, /The reply does not address every requested part/);
  assert.doesNotMatch(coverage, /Everything requested is complete|The final answer responds to every part/);

  const guardFailure = composeEvidenceSummary("Everything requested is complete.", {
    overall: "fail", criteria: [...base,
      { criterion: COVERAGE_CRITERION, status: "pass" },
      { criterion: PROVENANCE_CRITERION, status: "fail", evidence: "An entered value lacks a source." }]
  }, plan);
  assert.match(guardFailure, /Verified: The requested record is present/);
  assert.match(guardFailure, /A required check failed/);
  assert.doesNotMatch(guardFailure, /Everything requested is complete|UNSOURCED_FIELD_VALUES|every value entered or sent/);

  const guardUnknown = composeEvidenceSummary("Everything requested is complete.", {
    overall: "fail", criteria: [...base,
      { criterion: COVERAGE_CRITERION, status: "pass" },
      { criterion: "An additional required guard", status: "unverifiable" }]
  }, plan);
  assert.match(guardUnknown, /A required check could not be confirmed/);
  assert.doesNotMatch(guardUnknown, /Everything requested is complete|An additional required guard/);
});

test("missing planned answer criteria fail closed in terminal evidence summaries", () => {
  const state = "The requested record is present.";
  const answerFact = "The response names the requested account.";
  const plan = { stateCriteria: [state], doneCriteria: [state, answerFact] };
  const verdict = { overall: "pass", criteria: [
    { criterion: state, status: "pass" },
    { criterion: COVERAGE_CRITERION, status: "pass" },
    { criterion: HONESTY_CRITERION, status: "pass" },
    { criterion: AGREEMENT_CRITERION, status: "pass" }
  ] };
  const summary = composeEvidenceSummary("The account is Acme and everything is done.", verdict, plan);
  assert.match(summary, /Verified: The requested record is present/);
  assert.match(summary, /Not confirmed: The response names the requested account/);
  assert.doesNotMatch(summary, /Acme|everything is done/);
});

test("evidence summary cannot leak a false raw answer when outcome truthfulness is unknown", () => {
  const criterion = "The report contains the requested figure.";
  const answer = "The report contains $500 and everything is complete.";
  const verdict = { overall: "fail", criteria: [
    { criterion, status: "pass" },
    { criterion: HONESTY_CRITERION, status: "unverifiable" },
    { criterion: AGREEMENT_CRITERION, status: "unverifiable" }
  ] };
  const summary = composeEvidenceSummary(answer, verdict, { stateCriteria: [criterion] });
  assert.match(summary, new RegExp(`Verified: ${criterion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(summary, /Not fully confirmed/);
  assert.doesNotMatch(summary, /\$500|everything is complete/);
});

test("nonpassing summary explains a missing prerequisite without repeating raw completion claims", () => {
  const criterion = "The requested record is submitted with all required values.";
  const answer = "The record was submitted successfully with all required values.";
  const evidence = "A required priority was unavailable, so no record was submitted. More context follows. " + "Additional context. ".repeat(30);
  const verdict = { overall: "fail", criteria: [
    { criterion, status: "fail", evidence },
    { criterion: COVERAGE_CRITERION, status: "pass", evidence: "The answer addresses the request." },
    { criterion: HONESTY_CRITERION, status: "fail", evidence: "No submission is present in the action results." },
    { criterion: AGREEMENT_CRITERION, status: "fail", evidence: "The completion statement conflicts with the results." }
  ] };

  const summary = composeEvidenceSummary(answer, verdict, { stateCriteria: [criterion], doneCriteria: [criterion] });
  assert.match(summary, /Failed: The requested record is submitted with all required values\./);
  assert.match(summary, /Reason: “A required priority was unavailable, so no record was submitted\./);
  assert.doesNotMatch(summary, /submitted successfully|follows|Additional context/);
  const evidenceLine = summary.split("\n").find(line => line.includes("Reason: “"));
  assert.ok(evidenceLine.length < 260, "summary evidence is bounded");
  const evidenceText = evidenceLine.split("“")[1].split("”")[0];
  assert.ok(evidenceText.match(/\b\w+\b/g).length <= 12, "summary evidence is limited to twelve words");
});

test("mixed nonpassing summary retains each outcome's evidence and verified partial facts", () => {
  const first = "The first requested outcome is complete.";
  const second = "The second requested outcome is complete.";
  const answerFact = "The response includes the verified total.";
  const verifiedAnswerEvidence = "The displayed total is 500 dollars, with fees included and all requested line items checked, but tax and shipping are excluded.";
  const plan = { stateCriteria: [first, second], doneCriteria: [first, second, answerFact] };
  const answer = "Both outcomes are complete and the total is 500.";
  const verdict = { overall: "fail", criteria: [
    { criterion: first, status: "pass", evidence: "The first item appears in the current record." },
    { criterion: second, status: "unverifiable", evidence: "The destination value is missing from available results." },
    { criterion: answerFact, status: "pass", evidence: verifiedAnswerEvidence },
    { criterion: COVERAGE_CRITERION, status: "pass" },
    { criterion: HONESTY_CRITERION, status: "unverifiable" },
    { criterion: AGREEMENT_CRITERION, status: "unverifiable" }
  ] };

  const summary = composeEvidenceSummary(answer, verdict, plan);
  assert.match(summary, /Verified: The first requested outcome is complete\./);
  assert.match(summary, /Not confirmed: The second requested outcome is complete\..*Reason: “The destination value is missing from available results\.”/s);
  assert.ok(summary.includes(`Verified answer fact: ${verifiedAnswerEvidence}`), "passing answer evidence retains its full qualifier");
  assert.doesNotMatch(summary, /Both outcomes are complete/);
});

test("missing verifier evidence preserves non-success status without inventing an explanation", () => {
  const failed = "The requested change is complete.";
  const unknown = "The requested answer is complete.";
  const answer = "The requested change and answer are complete.";
  const verdict = { overall: "fail", criteria: [
    { criterion: failed, status: "fail" },
    { criterion: unknown, status: "unverifiable", evidence: "  \n\t " },
    { criterion: COVERAGE_CRITERION, status: "pass" },
    { criterion: HONESTY_CRITERION, status: "unverifiable" },
    { criterion: AGREEMENT_CRITERION, status: "unverifiable" }
  ] };

  const summary = composeEvidenceSummary(answer, verdict, { stateCriteria: [failed], doneCriteria: [failed, unknown] });
  assert.match(summary, /Failed: The requested change is complete\./);
  assert.match(summary, /Not confirmed: The requested answer is complete\./);
  assert.doesNotMatch(summary, /Reason:|requested change and answer are complete/);
});

test("nonpassing evidence sanitizes controls and bounds a single oversized word", () => {
  const longWordCriterion = "The first outcome is complete.";
  const controlCriterion = "The second outcome is complete.";
  const verdict = { overall: "fail", criteria: [
    { criterion: longWordCriterion, status: "fail", evidence: "x".repeat(500) },
    { criterion: controlCriterion, status: "unverifiable", evidence: "required\u0000value\nremains missing" },
    { criterion: COVERAGE_CRITERION, status: "pass" },
    { criterion: HONESTY_CRITERION, status: "unverifiable" },
    { criterion: AGREEMENT_CRITERION, status: "unverifiable" }
  ] };

  const summary = composeEvidenceSummary("Both outcomes completed.", verdict, { stateCriteria: [longWordCriterion, controlCriterion] });
  const longLine = summary.split("\n").find(line => line.startsWith(`Failed: ${longWordCriterion}`));
  assert.ok(longLine.length < 260, "a single long word remains within the evidence limit");
  assert.match(longLine, /Reason: “x+…”$/);
  const controlLine = summary.split("\n").find(line => line.startsWith(`Not confirmed: ${controlCriterion}`));
  assert.match(controlLine, /Reason: “required value remains missing”$/);
  assert.doesNotMatch(summary, /\u0000|Both outcomes completed/);
});

test("fresh scoped continuation requires changed current evidence and no later mutation", () => {
  const scoped = { callId: "scoped", command: "agent browser run --goal complete the current operation", source: JSON.stringify({
    status: "done", scopedOperation: { status: "activated", goalVerified: false },
    session: "s1", finalUrl: "https://example.test/confirm",
    observations: { firstObserved: "Initial page", current: "Confirmation page" }
  }) };
  const read = { command: "agent browser inspect --session s1", source: "Current page controls" };
  assert.equal(freshScopedContinuation([scoped]).context.current, "Confirmation page");
  assert.equal(freshScopedContinuation([scoped, read]).context.session, "s1", "later read-only work leaves the latest scoped operation usable");
  assert.equal(freshScopedContinuation([scoped, { command: "records update --id r1", source: '{"status":"done"}' }]), null);
  assert.equal(freshScopedContinuation([{ ...scoped, source: JSON.stringify({
    scopedOperation: { goalVerified: false }, session: "s1", observations: { firstObserved: "Page", current: "Page" }
  }) }]), null, "unchanged observation is not actionable progress");
  assert.equal(freshScopedContinuation([{ ...scoped, source: JSON.stringify({
    scopedOperation: { goalVerified: false }, session: "s1", observations: { firstObserved: "Page" }
  }) }]), null, "firstObserved alone is not current evidence");
  assert.equal(freshScopedContinuation([{ ...scoped, source: JSON.stringify({
    scopedOperation: { goalVerified: false }, session: "s1", observations: { firstObserved: "Page", current: { text: "Not a string observation" } }
  }) }]), null, "structured objects are not coerced into observation text");
  assert.equal(freshScopedContinuation([{ ...scoped, callId: undefined }]), null, "continuation requires a stable operation call identity for the pre-action read guard");
  const closedSession = freshScopedContinuation([{ ...scoped, source: JSON.stringify({
    status: "done", scopedOperation: { goalVerified: false }, session: "closed", sessionClosed: true,
    finalUrl: "https://example.test/confirm", observations: { firstObserved: "Initial page", current: "Confirmation page" }
  }) }]);
  assert.equal(closedSession.context.session, "", "a closed session falls back to the exact observed URL");
  assert.equal(closedSession.context.finalUrl, "https://example.test/confirm");

  const question = composeScopedContinuationQuestion({ goal: "finish the original task", stateCriteria: ["the outcome holds", "preserve the other record"], doneCriteria: [
    { text: "the outcome holds", kind: "state" }, { text: "preserve the other record", kind: "state" }, { text: "include the confirmed value", kind: "answer" }
  ] },
    { criteria: [{ criterion: "the outcome holds", status: "unverifiable" }, { criterion: "preserve the other record", status: "pass" }, { criterion: "include the confirmed value", status: "unverifiable" }] },
    freshScopedContinuation([scoped]).context, "finish the original task; preserve the other record");
  assert.match(question, /finish the original task; preserve the other record/);
  assert.match(question, /Live session: s1/);
  assert.match(question, /Current URL: https:\/\/example\.test\/confirm/);
  assert.match(question, /Current observation: Confirmation page/);
  assert.match(question, /include the confirmed value \(unverifiable\)/);
  assert.match(question, /first tool call must be a successful read-only observation/i);
  assert.doesNotMatch(question, /--target|confirm=yes|the old row descriptor/);
});

test("scoped read guard requires a successful post-operation observation in the returned location", () => {
  const context = { operationCallId: "op", operationCommand: "agent browser run --session s1", session: "s1", finalUrl: "https://example.test/confirm" };
  const op = { callId: "op", tool: "executeAux4", command: context.operationCommand, completed: true, failed: false };
  const oldRead = { callId: "old-read", tool: "executeAux4", command: "agent browser inspect --session s1", completed: true, failed: false, source: '{"elements":[]}' };
  const sameSessionRead = { callId: "fresh-read", tool: "executeAux4", command: "agent browser inspect --session s1", completed: true, failed: false, source: '{"elements":[],"complete":true}' };
  const otherSessionRead = { callId: "wrong-read", tool: "executeAux4", command: "agent browser inspect --session s2", completed: true, failed: false, source: '{"elements":[]}' };
  assert.match(scopedContinuationGuardMessage("agent browser run --session s2 --target new", [op], context), /first obtain a successful read-only observation/i);
  assert.match(scopedContinuationGuardMessage("agent browser inspect --session s2", [op], context), /returned live session/);
  assert.match(scopedContinuationGuardMessage("agent browser inspect --session s1 --url https://example.test/other", [op], context), /first obtain a successful read-only observation/i);
  assert.equal(scopedContinuationGuardMessage("agent browser inspect --session s1", [op], context), "");
  assert.equal(scopedContinuationGuardMessage("agent browser run --session s1 --target old", [op, sameSessionRead], context), "", "the pre-action guard opens after a successful same-session read; the completed-target deny rule remains separate");
  assert.equal(freshScopedReadAttempt([oldRead, op], context), null, "a read before the completed operation cannot satisfy freshness");
  assert.equal(freshScopedReadAttempt([op, otherSessionRead], context), null, "a different session cannot satisfy freshness");
  assert.equal(freshScopedReadAttempt([op, sameSessionRead], context), sameSessionRead);
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, source: '{"session":"s2","finalUrl":"https://example.test/confirm"}' }], context), null, "returned session metadata must agree when the read supplies it");
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, source: '{"session":"s1","finalUrl":"https://example.test/other"}' }], context), null, "returned URL metadata must agree when the read supplies it");
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, source: '{"answered":false,"matches":[]}' }], context), null, "an unanswered lookup is not a successful observation");
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, source: '{"answered":false,"matches":[],"question":"find the next control","provider":"mock"}' }], context), null, "a bare unanswered transport envelope has no current-page evidence");
  assert.ok(freshScopedReadAttempt([op, { ...sameSessionRead, source: '{"answered":false,"matches":[],"text":"Delete this address?","elements":[{"role":"button","name":"Yes, delete it"}]}' }], context), "an unanswered semantic query can still carry fresh page controls");
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, source: "{}" }], context), null, "an empty object is not an observation");
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, failed: true }], context), null, "a failed read does not open the guard");
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, source: "", result: "" }], context), null, "an empty tool echo is not a read observation");
  assert.equal(freshScopedReadAttempt([op, { ...sameSessionRead, source: '{"status":"needs-input","elements":[]}' }], context), null, "an explicit incomplete status is not a read observation");
});

test("runLoop takes at most one fresh scoped continuation and does not replay the completed command", async () => {
  const target = "The selected record is absent from the records list.";
  const protectedRecord = "The protected record remains in the records list.";
  const fake = makeFakeAux4(`
const args = process.argv.slice(2), command = args.join(" ");
if (command.includes("loop-plan.md")) {
  process.stdout.write(JSON.stringify({ goal: "Complete the requested record operation", doneCriteria: [
    { text: ${JSON.stringify(target)}, kind: "state" },
    { text: ${JSON.stringify(protectedRecord)}, kind: "state" }
  ] }));
} else if (command.includes("loop-verify.md")) {
  const question = args[args.indexOf("--question") + 1] || "";
  const payload = JSON.parse(question.slice(question.indexOf("{")));
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => {
    if (c.criterion === ${JSON.stringify(target)}) return { criterion:c.criterion,status:"unverifiable",evidence:"Current evidence is an intermediate page.",basis:"currentState",relation:"unknown",claim:"absence",coverage:"unknown" };
    if (c.criterion === ${JSON.stringify(protectedRecord)}) return { criterion:c.criterion,status:"pass",evidence:"Protected record appears in the current list.",basis:"currentState",relation:"supports",claim:"presence",coverage:"complete" };
    if (c.criterion === ${JSON.stringify(COVERAGE_CRITERION)}) return { criterion:c.criterion,status:"pass",evidence:"The response covers both requested outcomes." };
    return { criterion:c.criterion,status:"unverifiable",evidence:"The response claim cannot be confirmed." };
  }) }));
} else if (command.startsWith("agent browser find") || command.startsWith("agent browser inspect")) {
  process.stdout.write(JSON.stringify({ page: "Confirmation page with next control", complete: true }));
}
`);
  const history = path.relative(process.cwd(), tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} })));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    let firstCommand = "";
    let secondQuestion = "";
    let secondDenied = [];
    let secondPatterns = [];
    const freshDescriptorCommand = "agent browser run --session s1 --goal 'continue from the observed page' --target '{\"role\":\"button\",\"name\":\"Continue\"}'";
    const request = "Delete only the selected record; preserve the protected record.";
    const outcome = await runLoop(baseOptions({ request, hooksSupported: true }), history, (question, h, denied, _retry, deniedPatterns, continuationContext) => {
      calls++;
      if (calls === 2) {
        secondQuestion = question;
        secondDenied = [...denied];
        secondPatterns = [...deniedPatterns];
        assert.equal(continuationContext.session, "s1");
        assert.equal(continuationContext.finalUrl, "https://example.test/records/confirm");
        assert.equal(continuationContext.current, "Confirmation page with next control");
        const sidecar = JSON.parse(fs.readFileSync(`${h}.scoped-continuation.json`, "utf8"));
        assert.equal(sidecar.operationCallId, "scoped");
        assert.ok(denied.includes(firstCommand), "descriptor A remains denied after its completed click");
        assert.ok(!denied.includes(freshDescriptorCommand), "a fresh confirmation command is not denied by exact-command policy");
      }
      const data = JSON.parse(fs.readFileSync(h, "utf8"));
      const add = (id, command, result) => {
        data.messages.push({ role: "assistant_with_tool", content: { tool_calls: [{ id, name: "executeAux4", args: { command } }] } });
        data.messages.push({ role: "tool", tool_call_id: id, name: "executeAux4", content: result });
      };
      if (calls === 1) {
        firstCommand = "agent browser run --session s1 --goal 'Complete the requested record operation' --target '{\"role\":\"button\",\"name\":\"Continue\"}'";
        add("scoped", firstCommand, JSON.stringify({ status: "done", scopedOperation: { status: "activated", goalVerified: false }, session: "s1", finalUrl: "https://example.test/records/confirm", observations: { firstObserved: "Initial page", current: "Confirmation page with next control" } }));
        fs.writeFileSync(h, JSON.stringify(data));
        return "The target was removed successfully; done.";
      }
      assert.match(question, /first tool call must be a successful read-only observation/i);
      assert.match(question, /Delete only the selected record; preserve the protected record\./);
      assert.doesNotMatch(question, /--target|confirm=yes|Complete the requested record operation/);
      const beforeReadAttempts = extractAttemptLog(h);
      assert.match(scopedContinuationGuardMessage("agent browser run --session s2 --goal 'change other page'", beforeReadAttempts, continuationContext), /returned live session/);
      assert.match(scopedContinuationGuardMessage(firstCommand, beforeReadAttempts, continuationContext), /first obtain a successful read-only observation/i);
      const readCommand = "agent browser inspect --session s1";
      assert.equal(scopedContinuationGuardMessage(readCommand, beforeReadAttempts, continuationContext), "");
      add("fresh-read", readCommand, JSON.stringify({ page: "Confirmation page with next control", elements: [{ role: "button", name: "Continue" }], complete: true }));
      fs.writeFileSync(h, JSON.stringify(data));
      const afterReadAttempts = extractAttemptLog(h);
      assert.ok(freshScopedReadAttempt(afterReadAttempts, continuationContext));
      assert.equal(scopedContinuationGuardMessage(freshDescriptorCommand, afterReadAttempts, continuationContext), "", "fresh controls become actionable only after a successful read in the returned session");
      assert.ok(secondDenied.includes(firstCommand), "the old target command stays denied after the fresh read");
      assert.ok(!secondDenied.includes(freshDescriptorCommand), "the newly observed control can be used subject to existing guards");
      assert.ok(!freshDescriptorCommand.includes("confirm=yes"), "confirmation data is not copied from the consumed operation");
      add("fresh-action", freshDescriptorCommand, JSON.stringify({ status: "done", scopedOperation: { status: "activated", goalVerified: false }, session: "s1", finalUrl: "https://example.test/records/confirm", observations: { firstObserved: "Confirmation page", current: "Intermediate page" } }));
      fs.writeFileSync(h, JSON.stringify(data));
      return "The target was removed successfully; done.";
    });
    assert.equal(calls, 2, "one bounded continuation follows the changed current observation");
    assert.equal(outcome.stopped, "unverifiable-only");
    assert.match(secondQuestion, /Original request \(preserve all constraints and exclusions\): Delete only the selected record; preserve the protected record\./);
    assert.match(secondQuestion, /Live session: s1/);
    assert.match(secondQuestion, /Confirmation page with next control/);
    assert.doesNotMatch(secondQuestion, /Complete the requested record operation|--target|confirm=yes/);
    assert.ok(secondDenied.includes(firstCommand), "the completed change command remains denied during continuation");
    assert.deepEqual(secondPatterns, [], "the navigation click's unkeyed descriptor does not create a broad pattern denial that would block a fresh control");
    assert.ok(!secondPatterns.some(pattern => freshDescriptorCommand.includes(pattern.replace(/\*/g, ""))));
    const executePolicy = JSON.parse(mergeDenyPolicy(baseOptions().policy, secondDenied, secondPatterns));
    const executeDenied = executePolicy.deny.flatMap(rule => rule.executeAux4 || []);
    assert.ok(executeDenied.includes(firstCommand), "the actual next-round execute policy contains descriptor A");
    assert.ok(!executeDenied.includes(freshDescriptorCommand), "the actual next-round execute policy permits descriptor B");
    assert.match(outcome.content, new RegExp(`Verified: ${protectedRecord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(outcome.content, new RegExp(`Not confirmed: ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(outcome.content, /target was removed successfully/);
  });
});

test("runLoop stops without a scoped continuation when the executor cannot enforce its read guard", async () => {
  const target = "The requested outcome is true.";
  const fake = makeFakeAux4(`
const args = process.argv.slice(2), command = args.join(" ");
if (command.includes("loop-plan.md")) process.stdout.write(JSON.stringify({ goal: "Complete the request", doneCriteria: [{ text: ${JSON.stringify(target)}, kind: "state" }] }));
else if (command.includes("loop-verify.md")) {
  const question = args[args.indexOf("--question") + 1] || "";
  const payload = JSON.parse(question.slice(question.indexOf("{")));
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => c.criterion === ${JSON.stringify(target)}
    ? { criterion:c.criterion,status:"unverifiable",evidence:"Only an intermediate page was observed.",basis:"actionResult",relation:"unknown" }
    : { criterion:c.criterion,status:"pass",evidence:"Required checks pass." }) }));
}
`);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions({ request: "Complete the request." }), history, (_question, h) => {
      calls++;
      const data = JSON.parse(fs.readFileSync(h, "utf8"));
      data.messages.push(
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "scoped", name: "executeAux4", args: { command: "agent browser run --session s1 --goal complete the request --target next" } }] } },
        { role: "tool", tool_call_id: "scoped", name: "executeAux4", content: JSON.stringify({ status: "done", scopedOperation: { goalVerified: false }, session: "s1", finalUrl: "https://example.test/next", observations: { firstObserved: "start", current: "intermediate" } }) }
      );
      fs.writeFileSync(h, JSON.stringify(data));
      return "The requested operation succeeded.";
    });
    assert.equal(calls, 1);
    assert.equal(outcome.stopped, "unverifiable-only");
    assert.doesNotMatch(outcome.content, /requested operation succeeded/);

    const failedReadHistory = tmpFile("failed-read-history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
    let guardedCalls = 0;
    const failedRead = await runLoop(baseOptions({ request: "Complete the request.", hooksSupported: true }), failedReadHistory,
      (question, h, _denied, _retry, _patterns, context) => {
        guardedCalls++;
        const data = JSON.parse(fs.readFileSync(h, "utf8"));
        const add = (id, command, result) => {
          data.messages.push({ role: "assistant_with_tool", content: { tool_calls: [{ id, name: "executeAux4", args: { command } }] } });
          data.messages.push({ role: "tool", tool_call_id: id, name: "executeAux4", content: result });
        };
        if (guardedCalls === 1) {
          add("scoped", "agent browser run --session s1 --goal complete the request --target next", JSON.stringify({ status: "done", scopedOperation: { goalVerified: false }, session: "s1", finalUrl: "https://example.test/next", observations: { firstObserved: "start", current: "intermediate" } }));
          fs.writeFileSync(h, JSON.stringify(data));
          return "The requested operation succeeded.";
        }
        assert.match(question, /first tool call must be a successful read-only observation/i);
        assert.match(scopedContinuationGuardMessage("agent browser inspect --session s2", extractAttemptLog(h), context), /returned live session/);
        add("wrong-session", "agent browser inspect --session s2", "Error: this call was NOT run by the scoped continuation guard.");
        fs.writeFileSync(h, JSON.stringify(data));
        return "The requested operation succeeded.";
      });
    assert.equal(guardedCalls, 2, "one failed preflight is the only continuation opportunity");
    assert.equal(failedRead.stopped, "unverifiable-only");
    assert.doesNotMatch(failedRead.content, /requested operation succeeded/);
  });
});


test("explicit boolean directions cannot be reversed and negative control labels are respected", () => {
  assert.equal(unsourcedFieldValues(["Release notices=unchecked"],[],"Enable Release notices.")[0].directionMismatch,true);
  assert.deepEqual(unsourcedFieldValues(["Release notices=checked"],[],"Enable Release notices."),[]);
  assert.equal(unsourcedFieldValues(["Promotional mail=checked"],[],"Disable Promotional mail.")[0].directionMismatch,true);
  assert.deepEqual(unsourcedFieldValues(["No promotional mail=checked"],[],"Disable promotional mail."),[]);
  assert.deepEqual(unsourcedFieldValues(["Updates=checked"],[],"Do not disable Updates."),[]);
  assert.deepEqual(unsourcedFieldValues(["Security alerts=checked","Marketing=unchecked"],[],"Enable Security alerts and disable Marketing."),[]);
});


test("observed field comparison requires independent unambiguous facts", async () => {
  const {observedFieldValue}=await import("../lib/agent-loop.mjs");
  assert.equal(observedFieldValue("Display name",[{command:"records get",source:'{"displayName":"Ren"}'}]),"Ren");
  assert.equal(observedFieldValue("Name",[{command:"records list",source:'[{"name":"Ren"},{"name":"Kai"}]'}]),null);
  assert.equal(observedFieldValue("Name",[{command:'forms run --field "Name=Ren"',source:'{"Name":"Ren"}'}]),null);
  assert.equal(observedFieldValue("Name",[{command:"records get",failed:true,source:'{"Name":"Ren"}'}]),null);
});
