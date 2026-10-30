import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  unsourcedFieldValues,
  unsourcedRecipientValues,
  unsourcedValues,
  checkValuesHooksFile,
  writeCheckValuesHooksFile,
  detectAiAgentHooksSupport,
  resetHooksSupportCacheForTests
} from "../lib/agent-loop.mjs";
import { parseFields, checkValues, repeatedReadGuardMessage, scopedContinuationGuardMessage } from "../lib/check-values.mjs";

test("outbound addresses require exact identifiers from the request or successful reads", () => {
  const command = 'notifications send --to="Person <person@work.test>" --cc other@work.test';
  const read = { command: "contacts search --query Person", source: "Person <person@work.test>", failed: false };
  assert.deepEqual(unsourcedRecipientValues(command, [read], "Copy other@work.test"), []);
  assert.deepEqual(unsourcedRecipientValues(command, [], "Person works at work.test; copy other@work.test"),
    [{ label: "to", value: "person@work.test" }]);
  assert.deepEqual(unsourcedRecipientValues("contacts search --email guessed@work.test", [], "Find the address"), []);
  assert.deepEqual(unsourcedRecipientValues("notes create --body 'Example: fictional@work.test'", [], "Write an example"), []);
});

test("documentation, failed reads and write echoes cannot source an outbound address", () => {
  const command = "notifications send --recipient target@work.test";
  for (const prior of [
    { command: "contacts list --help", source: "target@work.test" },
    { command: "contacts get", source: "target@work.test", failed: true },
    { command, source: "sent to target@work.test" }
  ]) assert.equal(unsourcedRecipientValues(command, [prior]).length, 1);
  assert.equal(unsourcedValues([{ command, source: "sent to target@work.test" }]).length, 1);
  assert.deepEqual(unsourcedValues([
    { command, source: "blocked target@work.test", failed: true },
    { command: "contacts get", source: "target@work.test" },
    { command, source: "sent to target@work.test" }
  ]), []);
});

test("the command hook blocks an invented recipient and allows recovery after a lookup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-hook-"));
  try {
    const requestFile = path.join(dir, "request.txt");
    const history = path.join(dir, "history.json");
    fs.writeFileSync(requestFile, "Send the update to Morgan");
    writeHistory(history, []);
    const args = [path.resolve("package/lib/check-values.mjs"), "--repeatReadGuard", "true",
      "--requestFile", requestFile, "--history", history, "--command", "notifications send --to morgan@work.test"];
    const denied = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(denied.status, 1);
    assert.match(denied.stdout, /NOT run/);
    writeHistory(history, [
      { role: "assistant_with_tool", content: { tool_calls: [{ id: "lookup", name: "executeAux4", args: { command: "contacts search --query Morgan" } }] } },
      { role: "tool", tool_call_id: "lookup", content: "Morgan <morgan@work.test>" }
    ]);
    const allowed = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the live tool hook requires a fresh read in the returned session before allowing changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-continuation-hook-"));
  try {
    const history = path.relative(process.cwd(), path.join(dir, "history.json"));
    const historyAbs = path.resolve(history);
    const contextFile = path.resolve(`${history}.scoped-continuation.json`);
    const context = { operationCallId: "op", operationCommand: "agent browser run --session s1", session: "s1", finalUrl: "https://example.test/confirm" };
    const hooksFile = writeCheckValuesHooksFile("/pkg", history, "Continue the original request.");
    assert.ok(fs.existsSync(path.resolve(hooksFile)));
    const hookConfig = JSON.parse(fs.readFileSync(path.resolve(hooksFile), "utf8"));
    const scopedPath = hookConfig.hooks[0].before[0].match(/--scopedContinuationFile '([^']+)'/)?.[1];
    assert.equal(scopedPath, contextFile, "relative histories produce an absolute hook-sidecar path");
    assert.deepEqual(JSON.parse(fs.readFileSync(contextFile, "utf8")), { active: false }, "hook generation starts with an inactive sidecar for non-loop callers");
    const run = command => spawnSync(process.execPath, [path.resolve("package/lib/check-values.mjs"), "--repeatReadGuard", "true",
      "--history", historyAbs, "--command", command, "--scopedContinuationFile", contextFile], { encoding: "utf8", cwd: dir });
    const normalMode = run("records:workspace:archive/delete --recordId r7");
    assert.equal(normalMode.status, 0, normalMode.stdout + normalMode.stderr);
    writeHistory(history, [
      { role: "assistant_with_tool", content: { tool_calls: [{ id: "op", name: "executeAux4", args: { command: context.operationCommand } }] } },
      { role: "tool", tool_call_id: "op", name: "executeAux4", content: JSON.stringify({ status: "done", scopedOperation: { goalVerified: false }, session: "s1", finalUrl: context.finalUrl, observations: { firstObserved: "page", current: "confirm page" } }) }
    ]);
    fs.writeFileSync(contextFile, JSON.stringify({ ...context, active: true }));
    const outOfSession = run("agent browser run --session s2 --goal 'continue'");
    assert.equal(outOfSession.status, 1);
    assert.match(outOfSession.stdout, /returned live session \(s1\)/);
    const oldTarget = run("agent browser run --session s1 --goal 'repeat previous operation'");
    assert.equal(oldTarget.status, 1);
    assert.match(oldTarget.stdout, /successful read-only observation/);
    const nestedMutation = run("records:workspace:archive/delete --recordId r7");
    assert.equal(nestedMutation.status, 1, "non-browser mutations are guarded too");
    assert.match(nestedMutation.stdout, /successful read-only observation/);
    const freshRead = run("agent browser inspect --session s1");
    assert.equal(freshRead.status, 0, freshRead.stdout + freshRead.stderr);
    const data = JSON.parse(fs.readFileSync(history, "utf8"));
    data.messages.push(
      { role: "assistant_with_tool", content: { tool_calls: [{ id: "read", name: "executeAux4", args: { command: "agent browser inspect --session s1" } }] } },
      { role: "tool", tool_call_id: "read", name: "executeAux4", content: JSON.stringify({ elements: [{ role: "button", name: "Continue" }] }) }
    );
    fs.writeFileSync(history, JSON.stringify(data));
    const freshControl = run("agent browser run --session s1 --target '{\"role\":\"button\",\"name\":\"Continue\"}'");
    assert.equal(freshControl.status, 0, freshControl.stdout + freshControl.stderr);
    const releasedNestedMutation = run("records:workspace:archive/delete --recordId r7");
    assert.equal(releasedNestedMutation.status, 0, releasedNestedMutation.stdout + releasedNestedMutation.stderr);
    fs.writeFileSync(contextFile, JSON.stringify({ active: false }));
    const inactive = run("records:workspace:archive/delete --recordId r7");
    assert.equal(inactive.status, 0, inactive.stdout + inactive.stderr);
    fs.rmSync(contextFile);
    const missingGuardState = run("records:workspace:archive/delete --recordId r7");
    assert.equal(missingGuardState.status, 1, "removing the active sidecar cannot disable the guard");
    assert.match(missingGuardState.stdout, /guard could not read its state/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

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
  assert.equal(file.hooks.length, 3);
  const hook = file.hooks[2];
  assert.equal(hook.tool, "executeAux4");
  assert.equal(hook.command, "agent:browser/run");
  assert.equal(hook.params, undefined);
  assert.equal(hook.before.length, 2);
  assert.match(hook.before[0], /check-values\.mjs/);
  assert.match(hook.before[0], /\/pkg\/dir/);
  assert.deepEqual(file.hooks.slice(0, 2).map(h => h.command), ["*/*", "*/*/*"]);
  assert.match(file.hooks[0].before[0], /--repeatReadGuard true --history value\(__history\) --command value\(__commandLine\)/);
});

test("writeCheckValuesHooksFile writes the hooks file next to the history file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-values-test-"));
  const history = path.join(tmp, "history.json");
  const file = writeCheckValuesHooksFile("/pkg/dir", history);
  assert.equal(file, `${history}.hooks.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.hooks[2].command, "agent:browser/run");
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
  const step = checkValuesHooksFile("/pkg").hooks[2].before[1];
  assert.match(step, /--request value\(__request\) --history value\(__history\) --fieldsJson value\(field\)/);
  assert.doesNotMatch(step, /\$\{/);
});

test("repeated-read guard blocks only duplicate evidence without an intervening change", () => {
  const first = {
    tool: "executeAux4", command: "jobs status 2", failed: false,
    source: JSON.stringify({ id: "2", state: "RUNNING", duration: "1s" })
  };
  const second = {
    ...first,
    source: JSON.stringify({ id: "2", state: "RUNNING", duration: "2s" })
  };
  assert.equal(repeatedReadGuardMessage("jobs status 2", [first]), "");
  assert.match(repeatedReadGuardMessage("jobs status 2", [first, second]), /same evidence twice/);
  assert.equal(repeatedReadGuardMessage("jobs status 2 --help", [first, second]), "");
  assert.equal(repeatedReadGuardMessage("jobs status 3", [first, second]), "");
  assert.equal(repeatedReadGuardMessage("records get --recordId r7", [first, second]), "");
  assert.equal(repeatedReadGuardMessage("jobs status 2", [first, { ...second, completed: false }]), "");
  assert.match(repeatedReadGuardMessage("jobs status 2", [first, second, {
    tool: "executeAux4", command: "records update --id r7", completed: false, failed: false
  }]), /same evidence twice/);
  assert.equal(repeatedReadGuardMessage("jobs status 2", [first, second, {
    tool: "executeAux4", command: "calendar events update --id 1", failed: false, source: "updated"
  }]), "");
  assert.equal(repeatedReadGuardMessage("jobs status 2", [first, {
    ...second,
    source: JSON.stringify({ id: "2", state: "COMPLETED", duration: "2s" })
  }]), "");
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
  const hook = JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks[2];
  assert.match(hook.before[0], /--scopedContinuationFile '\/.*h\.json\.scoped-continuation\.json'/);
  assert.match(hook.before[1], /--requestFile \/.*h\.json\.request\.txt$/);
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


test("recipient format follows the installed parameter contract, not a command-name rule", () => {
  const mailHelp = "send\nSend a notification.\n\n  --to <arg>\n    Recipient email address.\n\n  --body <optional>\n    Message text.";
  assert.deepEqual(unsourcedRecipientValues("notifications send --to Morgan", [], "Send to Morgan", mailHelp),
    [{ label: "to", value: "Morgan", invalidFormat: true }]);
  assert.deepEqual(unsourcedRecipientValues("notifications send --to morgan@work.test", [], "Send to morgan@work.test", mailHelp), []);
  const channelHelp = "send\n  --to <arg>\n    Channel name or account identifier.\n  --body <arg>\n    Text, including email examples.";
  assert.deepEqual(unsourcedRecipientValues("notifications send --to team-updates", [], "Post to team-updates", channelHelp), []);
  const pending = { command: "contacts get Morgan", completed: false, source: "morgan@work.test" };
  assert.equal(unsourcedRecipientValues("notifications send --to morgan@work.test", [pending], "Send to Morgan", mailHelp).length, 1);
});


test("the live hook reads parameter help and rejects a display name for an email destination", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typed-recipient-hook-"));
  try {
    const bin = path.join(dir, "aux4");
    fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.at(-1) !== '--help') process.exit(2);
console.log('send\\n  --to <arg>\\n    Recipient email address.\\n  --body <arg>\\n    Text.');
`, { mode: 0o755 });
    const history = path.join(dir, "history.json");
    writeHistory(history, []);
    const args = [path.resolve("package/lib/check-values.mjs"), "--repeatReadGuard", "true",
      "--request", "Send the update to Morgan", "--history", history, "--command", "notifications send --to Morgan"];
    const denied = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, AUX4_BIN: bin } });
    assert.equal(denied.status, 1, denied.stdout + denied.stderr);
    assert.match(denied.stdout, /recipient address Morgan is not established/);
    assert.match(denied.stdout, /successful lookup|matching record/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("a missing routing address returns actual parent lookup documentation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-lookup-help-"));
  try {
    const bin = path.join(dir, "aux4");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.at(-1) !== '--help') process.exit(2);
console.log(args.length === 2
 ? 'notifications\\n  list\\n  Search messages.\\n    --query <arg>\\n  get\\n  Read a matching message.\\n    --recordId <arg>'
 : 'send\\n  --to <arg>\\n    Recipient email address.');
`, {mode:0o755});
    const history = path.join(dir, 'history.json');
    writeHistory(history, []);
    const result = spawnSync(process.execPath, [path.resolve('package/lib/check-values.mjs'),
      '--repeatReadGuard', 'true', '--history', history, '--request', 'Send the update to Morgan',
      '--command', 'notifications send --to Morgan'], {encoding:'utf8',env:{...process.env,AUX4_BIN:bin}});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Installed CLI lookup reference/);
    assert.match(result.stdout, /--query <arg>/);
    assert.match(result.stdout, /--recordId <arg>/);
    assert.match(result.stdout, /documentation only/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("native field writes use original authority and factual history, never a forwarded goal",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-value-source-'));
  const request=path.join(dir,'request.txt'),history=path.join(dir,'history.json'),parent=path.join(dir,'parent.json');
  const guard=path.resolve('package/lib/check-values.mjs');
  const save=(file,messages)=>fs.writeFileSync(file,JSON.stringify({messages}));
  const result=(id,command,content)=>[
    {role:'assistant_with_tool',content:{tool_calls:[{id,name:'executeAux4',args:{command}}]}},
    {role:'tool',tool_call_id:id,content:JSON.stringify(content)}
  ];
  const run=(field,extra={})=>spawnSync(process.execPath,[guard,'--requestFile',request,'--history',history,'--historyFiles',extra.histories||'[]','--fieldsStdin','true'],{encoding:'utf8',input:JSON.stringify({fields:[field],availableChoices:extra.choices||{}}),env:{...process.env,AUX4_AGENT_HISTORY_FILES:''}});
  try{
    fs.writeFileSync(request,'Submit the application using its assigned Class.');
    save(history,result('view','agent browser run --goal "Show the form"',{status:'done',observations:{current:'Class (Gold or Silver)'}}));
    const blocked=run({label:'Class',value:'Gold'});assert.notEqual(blocked.status,0);assert.doesNotMatch(blocked.stdout,/Gold/);
    save(parent,result('record','records get',{assignedClass:'Gold'}));
    assert.equal(run({label:'Class',value:'Gold'},{histories:JSON.stringify([parent])}).status,0);
    fs.writeFileSync(path.join(dir,'machine-request.txt'),'Submit using Class Platinum.');
    assert.notEqual(run({label:'Class',value:'Platinum'},{histories:JSON.stringify([parent])}).status,0);
    fs.writeFileSync(request,'Choose any available Class for the application.');
    assert.equal(run({label:'Class',value:'Silver'},{choices:{Class:['Gold','Silver']}}).status,0);
    assert.notEqual(run({label:'Class',value:'Platinum'},{choices:{Class:['Gold','Silver']}}).status,0);
    fs.writeFileSync(request,'Fill the form.');
    for(const label of ['Confirm',''])assert.notEqual(run({label,value:'unprovided-secret'}).status,0);
    const invalid=spawnSync(process.execPath,[guard,'--requestFile',request,'--history',history,'--fieldsStdin','true'],{encoding:'utf8',input:'{"fields":[]}',env:{...process.env,AUX4_AGENT_HISTORY_FILES:''}});
    assert.notEqual(invalid.status,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("nested delegation guard hooks preserve the original authority file",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'authority-source-'));
  try{
    const authority=path.join(dir,'original.txt');fs.writeFileSync(authority,'Change only the phone.');
    const history=path.join(dir,'child.json');
    const hooks=writeCheckValuesHooksFile('/agent',history,'A machine-written child goal.',{authorityRequestFile:authority});
    assert.equal(fs.readFileSync(authority,'utf8'),'Change only the phone.');
    assert.match(JSON.parse(fs.readFileSync(hooks,'utf8')).hooks[0].before[0],new RegExp(authority.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal(fs.readFileSync(history+'.request.txt','utf8'),'A machine-written child goal.');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
