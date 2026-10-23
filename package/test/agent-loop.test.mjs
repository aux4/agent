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

test("composeDiagnoseQuestion lists only the unmet criteria and offers all six classifications", () => {
  const plan = { goal: "ship it", doneCriteria: ["a", "b"], steps: [] };
  const verdict = {
    overall: "fail",
    criteria: [{ criterion: "a", status: "pass", evidence: "" }, { criterion: "b", status: "fail", evidence: "saw no change" }]
  };
  const q = composeDiagnoseQuestion(plan, verdict, []);
  assert.doesNotMatch(q, /- a \(pass\)/);
  assert.match(q, /- b \(fail\): saw no change/);
  for (const cls of ["wrong_tool", "wrong_parameters", "tool_error", "incomplete", "misread_facts", "blocked"]) {
    assert.match(q, new RegExp(`FAILURE_CLASS: ${cls}`));
  }
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

function planVerifyFake({ verifyStatus = "pass" } = {}) {
  return makeFakeAux4(`
const args = process.argv.slice(2);
const command = args.join(" ");
if (command.includes("loop-plan.md")) {
  process.stdout.write(JSON.stringify({ goal: "g", doneCriteria: ["the outcome holds"], steps: [] }));
} else if (command.includes("loop-verify.md")) {
  process.stdout.write(JSON.stringify({ results: [{ criterion: "the outcome holds", status: "${verifyStatus}", evidence: "checked" }] }));
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
