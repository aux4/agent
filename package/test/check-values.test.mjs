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

test("unsourcedFieldValues skips the confirmation flag and placeholders", () => {
  const found = unsourcedFieldValues(["confirm=yes", "note=<optional>"], [], "");
  assert.deepEqual(found, []);
});

// --- checkValuesHooksFile / writeCheckValuesHooksFile ----------------------

test("checkValuesHooksFile targets executeAux4 on agent:browser/run gated on confirm=yes", () => {
  const file = checkValuesHooksFile("/pkg/dir");
  assert.equal(file.hooks.length, 1);
  const hook = file.hooks[0];
  assert.equal(hook.tool, "executeAux4");
  assert.equal(hook.command, "agent:browser/run");
  assert.deepEqual(hook.params, { field: "confirm=yes" });
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
  writeHistory(history, []);

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
  writeHistory(history, [
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
