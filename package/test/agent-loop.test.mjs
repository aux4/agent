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
  applyProvenance,
  activeDelegations,
  delegatedDenyPatterns,
  addDenyPatterns,
  describeFoundCommands,
  extractAttemptLog,
  summarizeAttemptLog,
  mergeDenyPolicy,
  sameFailureShape,
  extractFailureClass,
  isBlocked,
  composeDiagnoseQuestion,
  composeExecuteQuestion,
  incompleteNote,
  fallbackPlan,
  fallbackVerdict,
  runLoop,
  requireOwnObservation,
  verifyPayload,
  salvageVerdict,
  stripFailureClass,
  COVERAGE_CRITERION,
  HONESTY_CRITERION,
  AGREEMENT_CRITERION,
  verifyCriteria,
  allowedCommandsOffered,
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
  pendingConfirmationLabel,
  isClearlyRequestedAction,
  compactResult,
  composeRunNextQuestion,
  composeNeedsConfirmationAnswer
} from "../lib/agent-loop.mjs";

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
  assert.equal(attempts[1].command, "todo complete --id 9");
  assert.equal(attempts[1].failed, true);
  assert.match(attempts[1].resultSummary, /no such item/);
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

test("sameFailureShape compares criterion+status pairs, ignoring evidence wording", () => {
  const a = { criteria: [{ criterion: "x", status: "fail", evidence: "tried A" }] };
  const b = { criteria: [{ criterion: "x", status: "fail", evidence: "tried B, differently" }] };
  assert.equal(sameFailureShape(a, b), true);
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

function withAux4Bin(fake, fn) {
  const prior = process.env.AUX4_BIN;
  process.env.AUX4_BIN = fake;
  try {
    return fn();
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

test("runLoop stops immediately when a retry classifies itself as blocked", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let calls = 0;
    const outcome = await runLoop(baseOptions(), history, () => {
      calls++;
      return calls === 1 ? "first attempt text" : "FAILURE_CLASS: blocked\nI need the requester's approval.";
    });
    assert.equal(outcome.stopped, "blocked");
    assert.equal(outcome.attempts, 2);
    assert.match(outcome.content, /need the requester's approval/);
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

test("composeDiagnoseQuestion carries the full list of commands a denial offered", () => {
  const verdict = { overall: "fail", criteria: [{ criterion: "b", status: "fail", evidence: "not sent" }] };
  const long = "Permission denied: command \"x reply\" is not allowed. Commands you may run: " + Array.from({ length: 30 }, (_, i) => `aux4 cmd${i} list`).join(", ") + ", aux4 x send.";
  const q = composeDiagnoseQuestion({ goal: "g", doneCriteria: ["b"] }, verdict, [{ command: "x reply", failed: true, result: long, resultSummary: long.slice(0, 300) }]);
  assert.match(q, /Commands you may run: .*aux4 x send/);
});

test("a retry that tried a new action is not stopped as no-progress", async () => {
  const fake = planVerifyFake({ verifyStatus: "fail" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    let n = 0;
    const outcome = await runLoop(baseOptions(), history, (q, h) => {
      n++;
      const prior = JSON.parse(fs.readFileSync(h, "utf8")).messages;
      prior.push({ role: "assistant_with_tool", content: { tool_calls: [{ id: `c${n}`, name: "executeAux4", args: { command: `try ${n}` } }] } });
      prior.push({ role: "tool", tool_call_id: `c${n}`, content: "Error: no" });
      fs.writeFileSync(h, JSON.stringify({ messages: prior }));
      return "not yet";
    });
    assert.equal(outcome.stopped, "budget");
    assert.equal(n, RETRY_BUDGET + 1);
  });
});

test("missingParameterHints explains aux4's missing-parameter error", () => {
  const hints = missingParameterHints([{ command: "x send --body hi", failed: true, result: "Error executing command: Error to enter the value of to" }]);
  assert.match(hints.join(" "), /missing the required --to parameter/);
  assert.deepEqual(missingParameterHints([{ command: "x", failed: false, result: "ok" }]), []);
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
  assert.match(WORKING_RULES, /"Command not found", run --help on its parent group/);
});

test("working rules say to re-check a message against tool results before sending it", () => {
  assert.match(WORKING_RULES, /Before sending or submitting a message, re-read the tool results it depends on/);
});

test("findCommands merges pkger find results by rank and leaves out the agent's own commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-"));
  const bin = path.join(dir, "aux4");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const q = process.argv[process.argv.indexOf("--query") + 1];
const out = q === "open web page" ? [{command:"aux4 ai agent ask",score:9},{command:"aux4 aux4 pkger find",score:8},{command:"aux4 agent ask",score:7},{command:"aux4 agent browser run",description:"Run a goal.",score:0.1},{command:"aux4 browser open",description:"Open a page.",score:1},{command:"aux4 browser read",score:0.5}]
  : [{command:"aux4 google gmail trash",score:50},{command:"aux4 google gmail list",description:"List messages.",score:40},{command:"aux4 browser open",score:30}];
console.log(JSON.stringify(out));
`, { mode: 0o755 });
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    const found = findCommands(["open https://example.com/x", "b", ""]);
    assert.deepEqual(found.map(f => f.command), ["aux4 agent browser run", "aux4 google gmail trash", "aux4 browser open", "aux4 google gmail list", "aux4 browser read"]);
    const text = describeFoundCommands(found);
    assert.match(text, /run them through the executeAux4 tool/);
    assert.match(text, /- executeAux4 \{"command": "aux4 google gmail list --help"\} -- List messages\./);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(describeFoundCommands([]), "");
});

test("command lookup searches the plan's short lookFor phrases, else the request and steps", () => {
  assert.deepEqual(lookupQueries("Book a trip", { steps: ["s1"], lookFor: ["fill and submit a form on a web page"] }), ["fill and submit a form on a web page"]);
  assert.deepEqual(lookupQueries("Book a trip", { steps: ["s1"], lookFor: [] }), ["Book a trip", "s1"]);
  assert.deepEqual(lookupQueries("Book a trip", { steps: ["s1"] }), ["Book a trip", "s1"]);
});

test("a capability with a goal-level agent is delegated: its low-level commands are denied to the calling agent", () => {
  const delegations = activeDelegations(new Set(["main", "agent", "agent:browser", "browser"]));
  assert.equal(delegations.length, 1);
  assert.match(delegations[0].note, /executeAux4 with command "agent browser run --url/);
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
  return JSON.stringify({ messages: [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: firstCommand } }] } },
    { role: "tool", tool_call_id: "c1", content: JSON.stringify({ status: "needs-input", reason: `"${label}" cannot be undone, so the run stopped before it.`, next: nextCmd }) }
  ] });
}

test("pendingConfirmationLabel reads the quoted or bare action name before 'cannot be undone'", () => {
  assert.equal(pendingConfirmationLabel('"Save" cannot be undone, so the run stopped before it.'), "Save");
  assert.equal(pendingConfirmationLabel("Register cannot be undone"), "Register");
  assert.equal(pendingConfirmationLabel("something else entirely"), "");
});

test("pendingConfirmation detects a tool's own pending next-command confirmation, generically from the convention alone", () => {
  const next = "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'";
  const attempts = [{
    command: "agent browser run --session 's1' --goal 'g'",
    failed: false,
    result: JSON.stringify({ status: "needs-input", reason: '"Save" cannot be undone, so the run stopped before it.', next })
  }];
  const pending = pendingConfirmation(attempts);
  assert.equal(pending.label, "Save");
  assert.equal(pending.next, next);
  // the attempt IS the confirmation call itself -- nothing is pending
  assert.equal(pendingConfirmation([{ command: `x --field 'confirm=yes'`, failed: false, result: "ok" }]), null);
  // needs-input for an unrelated reason (no confirm=yes anywhere) is not a pending confirmation
  assert.equal(pendingConfirmation([{ command: "x", failed: false, result: '{"status":"needs-input","reason":"missing a field"}' }]), null);
  assert.equal(pendingConfirmation([]), null);
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
    const seen = [];
    const outcome = await runLoop(options, history, (question, h) => {
      seen.push({ question, gate: [...(options.gateDeny || [])] });
      if (seen.length === 1) {
        fs.writeFileSync(h, pendingConfirmFixture("Save", next));
        return "It needs confirmation before saving.";
      }
      const prior = JSON.parse(fs.readFileSync(h, "utf8")).messages;
      prior.push({ role: "assistant_with_tool", content: { tool_calls: [{ id: "c2", name: "executeAux4", args: { command: next } }] } });
      prior.push({ role: "tool", tool_call_id: "c2", content: '{"status":"done"}' });
      fs.writeFileSync(h, JSON.stringify({ messages: prior }));
      return "Saved the shipping details.";
    });
    assert.equal(seen.length, 2);
    assert.match(seen[1].question, /Run the next command now/);
    assert.match(seen[1].question, new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(seen[1].gate, []);
    assert.equal(outcome.stopped, "pass");
    // one round, not a retry: the loop never looped back for a second attempt.
    assert.equal(outcome.attempts, 1);
  });
});

test("an irreversible action beyond the request stops and asks -- no retry (HARN-035)", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Look up the shipping details for Jamie Fox." };
    let calls = 0;
    const outcome = await runLoop(options, history, (question, h) => {
      calls++;
      fs.writeFileSync(h, pendingConfirmFixture("Save", "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'"));
      return "It needs confirmation before saving.";
    });
    assert.equal(calls, 1);
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
    const outcome = await runLoop(options, history, (question, h) => {
      calls++;
      fs.writeFileSync(h, pendingConfirmFixture("Save", "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'"));
      return "It needs confirmation before saving.";
    });
    assert.equal(calls, 1);
    assert.equal(outcome.stopped, "needs-confirmation");
  });
});

test("the check-values hook keeps applying to the same-round confirm follow-up (HARN-035 does not bypass HARN-030)", async () => {
  const fake = planVerifyFake({ verifyStatus: "pass" });
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const options = { ...baseOptions(), request: "Save the shipping details for Jamie Fox.", hooksSupported: true, hooksFile: "fixed-hooks.json" };
    const next = "agent browser run --session 's1' --goal 'g' --field 'confirm=yes'";
    const seen = [];
    await runLoop(options, history, (question, h) => {
      seen.push({ hooksFile: options.hooksFile, gate: [...(options.gateDeny || [])] });
      if (seen.length === 1) {
        fs.writeFileSync(h, pendingConfirmFixture("Save", next));
        return "needs confirmation";
      }
      const prior = JSON.parse(fs.readFileSync(h, "utf8")).messages;
      prior.push({ role: "assistant_with_tool", content: { tool_calls: [{ id: "c2", name: "executeAux4", args: { command: next } }] } });
      prior.push({ role: "tool", tool_call_id: "c2", content: '{"status":"done"}' });
      fs.writeFileSync(h, JSON.stringify({ messages: prior }));
      return "saved";
    });
    // hooksFile (how the check-values before-hook is wired) is never touched by
    // this feature -- only gateDeny is opened for the one follow-up call.
    assert.equal(seen[0].hooksFile, "fixed-hooks.json");
    assert.equal(seen[1].hooksFile, "fixed-hooks.json");
    assert.deepEqual(seen[1].gate, []);
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

test("pendingConfirmation finds the confirm command inside a truncated result's reason text", () => {
  const result = `{\n  "status": "needs-input",\n  "reason": "\\"Save\\" cannot be undone, so the run stopped before it. You are about to run: Save. Next: aux4 agent browser run --session '7bb12572' --goal 'Fill out the form.' --field 'confirm=yes' Only run this once the person has asked.",\n  "finalUrl": "http://x/shipping", "steps": [`;
  const p = pendingConfirmation([{ command: "agent browser run --url http://x/shipping", result }]);
  assert.ok(p);
  assert.equal(p.label, "Save");
  assert.equal(p.next, "aux4 agent browser run --session '7bb12572' --goal 'Fill out the form.' --field 'confirm=yes'");
});

test("compactResult keeps a JSON result's short fields when one long field comes first", () => {
  const big = JSON.stringify({ status: "needs-input", reason: "x".repeat(2000), stepsText: ["select \"Plan\" = Pro", "fill \"Comments\" = Hi"], steps: [{ a: 1 }, { b: 2 }], next: "aux4 agent browser run --field 'confirm=yes'" });
  const c = compactResult(big, 800);
  assert.ok(c.length <= 800);
  assert.match(c, /"stepsText":\["select \\"Plan\\" = Pro","fill \\"Comments\\" = Hi"\]/);
  assert.match(c, /"steps":\["{1 fields}","{1 fields}"\]/);
  assert.match(c, /confirm=yes/);
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
  assert.equal(isClearlyRequestedAction("Cancel order ord-1", "find the order from the customer and cancel it"), true);
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
