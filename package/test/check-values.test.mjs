import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  unsourcedFieldValues,
  checkValuesHooksFile,
  writeCheckValuesHooksFile,
  detectAiAgentHooksSupport,
  resetHooksSupportCacheForTests
} from "../lib/agent-loop.mjs";
import { parseFields, checkValues } from "../lib/check-values.mjs";

function writeHistory(file, messages) {
  fs.writeFileSync(file, JSON.stringify({ messages }));
}

function confirmationResult(action, target = action, emptyFields = [], next = "aux4 agent browser run --session 's1' --goal 'g' --field 'confirm=yes'") {
  return JSON.stringify({
    status: "needs-input",
    reason: "approval required",
    confirmation: { action, target, emptyFields, next },
    next
  });
}

// --- unsourcedFieldValues --------------------------------------------------

test("unsourcedFieldValues flags a value that appears nowhere (the membership case)", () => {
  const found = unsourcedFieldValues(["Employee id=12345", "confirm=yes"], [], "Submit the order");
  assert.equal(found.length, 1);
  assert.equal(found[0].label, "Employee id");
  assert.equal(found[0].value, "12345");
});

test("unsourcedFieldValues passes a value that came from the request", () => {
  const found = unsourcedFieldValues(["Employee id=90210", "confirm=yes"], [], "The employee id is 90210");
  assert.deepEqual(found, []);
});

test("unsourcedFieldValues passes a value sourced from an earlier tool result", () => {
  const attempts = [{ command: "x lookup", result: "Employee id: 90210", source: "Employee id: 90210" }];
  const found = unsourcedFieldValues(["Employee id=90210", "confirm=yes"], attempts, "Submit the order");
  assert.deepEqual(found, []);
});

test("unsourcedFieldValues skips the confirmation flag but flags a placeholder copied verbatim", () => {
  const found = unsourcedFieldValues(["confirm=yes", "note=<optional>"], [], "");
  assert.deepEqual(found, [{ label: "note", value: "<optional>" }]);
});

// --- checkValuesHooksFile / writeCheckValuesHooksFile ----------------------

test("checkValuesHooksFile targets executeAux4 on every agent:browser/run call", () => {
  const file = checkValuesHooksFile("/pkg/dir");
  assert.equal(file.hooks.length, 1);
  const hook = file.hooks[0];
  assert.equal(hook.tool, "executeAux4");
  assert.equal(hook.command, "agent:browser/run");
  assert.equal(hook.params, undefined);
  assert.equal(hook.before.length, 1);
  assert.match(hook.before[0], /check-values\.mjs/);
  assert.match(hook.before[0], /\/pkg\/dir/);
});

test("writeCheckValuesHooksFile writes the hooks file next to the history file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const history = path.join(tmp, "history.json");
  const file = writeCheckValuesHooksFile("/pkg/dir", history);
  assert.equal(file, `${history}.hooks.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.hooks[0].command, "agent:browser/run");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- detectAiAgentHooksSupport ---------------------------------------------

test("detectAiAgentHooksSupport is true when the installed ai-agent's --help mentions --hooks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const bin = path.join(tmp, "aux4-with-hooks");
  fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.stdout.write('--hooks <file>  Path to a hooks file');\n");
  fs.chmodSync(bin, 0o755);

  resetHooksSupportCacheForTests();
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    assert.equal(detectAiAgentHooksSupport(), true);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN;
    else process.env.AUX4_BIN = previous;
    resetHooksSupportCacheForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectAiAgentHooksSupport is false against an older ai-agent with no --hooks flag", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const bin = path.join(tmp, "aux4-without-hooks");
  fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.stdout.write('--instructions <file>  Prompt instructions file');\n");
  fs.chmodSync(bin, 0o755);

  resetHooksSupportCacheForTests();
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = bin;
  try {
    assert.equal(detectAiAgentHooksSupport(), false);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN;
    else process.env.AUX4_BIN = previous;
    resetHooksSupportCacheForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectAiAgentHooksSupport is false, not thrown, when aux4 itself is unavailable", () => {
  resetHooksSupportCacheForTests();
  const previous = process.env.AUX4_BIN;
  process.env.AUX4_BIN = "/no/such/binary";
  try {
    assert.equal(detectAiAgentHooksSupport(), false);
  } finally {
    if (previous === undefined) delete process.env.AUX4_BIN;
    else process.env.AUX4_BIN = previous;
    resetHooksSupportCacheForTests();
  }
});

// --- check-values.mjs (the hook's own CLI) ---------------------------------

test("parseFields: JSON array, plain string, and invalid JSON all normalize to an array", () => {
  assert.deepEqual(parseFields('["Employee id=12345","confirm=yes"]'), ["Employee id=12345", "confirm=yes"]);
  assert.deepEqual(parseFields("confirm=yes"), ["confirm=yes"]);
  assert.deepEqual(parseFields(""), []);
});

test("checkValues: the membership case -- a made-up employee id is blocked", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const history = path.join(tmp, "history.json");
  const next = "aux4 agent browser run --session 's1' --goal 'Submit the order' --field 'confirm=yes'";
  writeHistory(history, [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c0", name: "executeAux4", args: { command: "agent browser run --url http://shop/order --goal 'Submit the order'" } }] } },
    { role: "tool", tool_call_id: "c0", content: confirmationResult("Submit order", "Submit order", [], next) }
  ]);

  const unsourced = checkValues({
    request: "Submit the order",
    history,
    fieldsJson: JSON.stringify(["Employee id=12345", "confirm=yes"])
  });

  assert.equal(unsourced.length, 1);
  assert.equal(unsourced[0].value, "12345");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("checkValues: a sourced value passes in one round", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const history = path.join(tmp, "history.json");
  const next = "aux4 agent browser run --session 's1' --goal 'Submit the order' --field 'confirm=yes'";
  writeHistory(history, [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c0", name: "executeAux4", args: { command: "agent browser run --url http://shop/order --goal 'Submit the order'" } }] } },
    { role: "tool", tool_call_id: "c0", content: confirmationResult("Submit order", "Submit order", [], next) },
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c1", name: "executeAux4", args: { command: "agent directory lookup --name Bob" } }] } },
    { role: "tool", tool_call_id: "c1", content: "Employee id: 90210" }
  ]);

  const unsourced = checkValues({
    request: "Submit the order for Bob",
    history,
    fieldsJson: JSON.stringify(["Employee id=90210", "confirm=yes"])
  });

  assert.deepEqual(unsourced, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the check-values hook passes the request and history with value(), never raw ${...} in a shell line", () => {
  const step = checkValuesHooksFile("/pkg").hooks[0].before[0];
  assert.match(step, /--request value\(__request\) --history value\(__history\) --fieldsJson value\(field\)/);
  assert.doesNotMatch(step, /\$\{/);
});

test("unsourcedFieldValues: a value echoed back by the call that typed it is not a source", () => {
  const attempts = [{
    command: "agent browser run --session 's1' --goal 'Register' --field 'Employee id=12345'",
    result: '{"status":"needs-input","stepsText":["fill \\"Employee id\\" = 12345"]}',
    source: '{"status":"needs-input","stepsText":["fill \\"Employee id\\" = 12345"]}'
  }];
  const found = unsourcedFieldValues(["Employee id=12345"], attempts, "Register Jamie Fox");
  assert.deepEqual(found, [{ label: "Employee id", value: "12345" }]);
});

test("unsourcedFieldValues: yes/no for a choice the request names is intent, not a made-up value", () => {
  const request = "Fill out the survey: plan Pro, subscribe to product updates, start date 2026-04-01.";
  assert.deepEqual(unsourcedFieldValues(["Subscribe to product updates=yes"], [], request), []);
  assert.deepEqual(unsourcedFieldValues(["Newsletter opt-in=yes"], [], request), [{ label: "Newsletter opt-in", value: "yes" }]);
  assert.deepEqual(unsourcedFieldValues(["Employee id (found on your badge)=12345"], [], "Register using the employee id on file"), [{ label: "Employee id (found on your badge)", value: "12345" }]);
});

import { dataEntries, confirmsAction, enteredValues } from "../lib/agent-loop.mjs";
import { confirmationWasAsked } from "../lib/check-values.mjs";

test("--data JSON values are entered values, checked like --field", () => {
  assert.deepEqual(dataEntries('{"Employee id":"12345","nested":{"Code":"X-1"}}'), [{ label: "Employee id", value: "12345" }, { label: "nested.Code", value: "X-1" }]);
  assert.deepEqual(enteredValues(`agent browser run --session 's' --data '{"Size":"Large"}'`), [{ label: "Size", value: "Large" }]);
  const found = unsourcedFieldValues(dataEntries('{"Employee id":"12345"}').map(e => `${e.label}=${e.value}`), [], "Register using the id on file");
  assert.equal(found.length, 1);
});

test("a confirm passed as --data counts as a confirmation", () => {
  assert.equal(confirmsAction(`agent browser run --url x --goal g --data '{"confirm":"yes"}'`), true);
  assert.equal(confirmsAction(`agent browser run --url x --goal g --data '{"Confirm":true}'`), true);
  assert.equal(confirmsAction(`agent browser run --url x --goal g --field 'confirm=yes'`), true);
  assert.equal(confirmsAction(`agent browser run --url x --goal g --data '{"Size":"Large"}'`), false);
});

test("a confirmation is only valid after a tool emitted the structured contract", () => {
  assert.equal(confirmationWasAsked([]), false);
  assert.equal(confirmationWasAsked([{ command: "agent browser run --url x", result: '{"status":"done"}' }]), false);
  const legacy = JSON.stringify({ status: "needs-input", next: "aux4 agent browser run --field 'confirm=yes'" });
  assert.equal(confirmationWasAsked([{ command: "agent browser run --url x", result: legacy }]), false);
  assert.equal(confirmationWasAsked([{ command: "agent browser run --url x", result: confirmationResult("Cancel", "Cancel order A-17") }]), true);
  const pre = checkValues({ request: "cancel the order", history: "/nonexistent", fieldsJson: "", dataJson: '{"confirm":"yes"}' });
  assert.deepEqual(pre, [{ label: "confirm", value: "yes", notAsked: true }]);
});

test("a URL's host and port are not a source for a value; its path still is", () => {
  const request = "Register for membership at http://127.0.0.1:7400/membership for Jamie Fox. Use the employee id on file.";
  assert.deepEqual(unsourcedFieldValues(["Employee id=7400"], [], request), [{ label: "Employee id", value: "7400" }]);
  const attempts = [{ command: "agent browser find --url x", source: '{"finalUrl":"http://127.0.0.1:7400/membership"}' }];
  assert.deepEqual(unsourcedFieldValues(["Employee id=7400"], attempts, request), [{ label: "Employee id", value: "7400" }]);
  assert.deepEqual(unsourcedFieldValues(["Order=ord-0042"], [], "cancel http://shop.example/orders/ord-0042"), []);
});

test("a confirmation for a specific item the request does not pick out is blocked (ask the person)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const history = path.join(tmp, "history.json");
  const next = "aux4 agent browser run --session 's1' --goal 'Cancel the order.' --field 'confirm=yes'";
  writeHistory(history, [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c0", name: "executeAux4", args: { command: "agent browser run --url http://shop.test/orders --goal 'Cancel the order.'" } }] } },
    { role: "tool", tool_call_id: "c0", content: confirmationResult("Cancel order", "Cancel order A-17", [], next) }
  ]);
  const vague = checkValues({ request: "Please cancel my order", history, fieldsJson: "confirm=yes" });
  assert.equal(vague.length, 1);
  assert.equal(vague[0].unclear, true);
  assert.deepEqual(checkValues({ request: "Please cancel order A-17", history, fieldsJson: "confirm=yes" }), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the hook reads the person's original request from the file next to the history", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const history = path.join(tmp, "h.json");
  const hooksFile = writeCheckValuesHooksFile("/pkg", history, "Please cancel my order");
  assert.equal(fs.readFileSync(`${history}.request.txt`, "utf8"), "Please cancel my order");
  assert.match(JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks[0].before[0], /--requestFile \/.*h\.json\.request\.txt$/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a confirmation is blocked while the structured contract reports empty fields", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const history = path.join(tmp, "history.json");
  const pending = (empty) => [
    { role: "assistant_with_tool", content: { tool_calls: [{ id: "c0", name: "executeAux4", args: { command: "agent browser run --url http://x/form --goal 'Send the form'" } }] } },
    { role: "tool", tool_call_id: "c0", content: confirmationResult("Send", "Send", empty || [], "aux4 agent browser run --session 's1' --goal 'Send the form' --field 'confirm=yes'") }
  ];
  writeHistory(history, pending(["Full name", "Priority"]));
  const blocked = checkValues({ request: "Send the form for me", history, fieldsJson: "confirm=yes" });
  assert.deepEqual(blocked[0].emptyFields, ["Full name", "Priority"]);
  writeHistory(history, pending([]));
  assert.deepEqual(checkValues({ request: "Send the form for me", history, fieldsJson: "confirm=yes" }), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the which-item rule never blocks a form's own submit", async () => {
  const { namesUnselectedItem } = await import("../lib/agent-loop.mjs");
  assert.equal(namesUnselectedItem("Submit", "Fill out the contact form for Priya Shah"), false);
  assert.equal(namesUnselectedItem("Submit survey", "Fill out the survey: plan Pro"), false);
  assert.equal(namesUnselectedItem("Cancel order ord-0001", "Please cancel my order"), true);
});

test("a tool confirmation contract counts as asking", () => {
  assert.equal(confirmationWasAsked([{ command: "agent browser run --url x", source: confirmationResult("Submit", "Submit") }]), true);
  assert.equal(confirmationWasAsked([{ command: "agent browser run --url x", source: '{"status":"needs-input","reason":"filled"}' }]), false);
});
