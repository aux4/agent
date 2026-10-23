import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseJSONLoose,
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
  allowedCommandsOffered,
  readBackCandidates,
  askedWithoutLooking,
  describedWithoutDoing,
  missingParameterHints,
  verifyToolList,
  isSafeReadBack,
  pickFromReply,
  onlyAnswerFailed,
  historyStats,
  metricsPath,
  readVerdict,
  verdictLogPath,
  RETRY_BUDGET
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
  assert.deepEqual(payload.criteria.map(c => c.kind), ["state", "answer", "answer", "answer"]);
  assert.equal(payload.criteria[2].criterion, COVERAGE_CRITERION);
  assert.deepEqual(payload.actions.map(a => a.result), ["1. buy milk", "Error: no such item 9"]);
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
else if (command.includes("loop-verify.md")) process.stdout.write(JSON.stringify({ results: [{ criterion: "Reply names item.", status: "pass", evidence: "it does" }, { criterion: "covers all", status: "pass", evidence: "yes" }, { criterion: "honest", status: "pass", evidence: "matches" }] }));
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
    { command: "x list --help", failed: false },
    { command: "x list", failed: false },
    { command: "x get 1", failed: true },
    { command: "x list", failed: false },
    { command: "x delete 1", failed: false }
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

test("verifyToolList keeps only the tools that observe", () => {
  assert.equal(verifyToolList("executeAux4,writeFile,readFile,askUser"), "executeAux4,readFile");
  assert.equal(verifyToolList(""), "executeAux4,readFile,listFiles,searchFiles,readReference");
  assert.equal(verifyToolList("writeFile"), "readReference");
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
`);
  const history = tmpFile("history.json", JSON.stringify({ messages: [], tokenUsage: {} }));
  await withAux4Bin(fake, async () => {
    const outcome = await runLoop(baseOptions(), history, (q, h) => {
      fs.writeFileSync(h, JSON.stringify({ messages: [
        { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: "echo empty" } }] } },
        { role: "tool", tool_call_id: "c1", content: "empty" }
      ] }));
      return "removed it";
    });
    assert.equal(outcome.stopped, "pass");
    assert.deepEqual(outcome.verdict.checks, ["echo empty"]);
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
});
