import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const harness = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../lib/harness.mjs");

function makeFakeAux4(body) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-test-"));
  const fake = path.join(folder, "aux4-fake");
  fs.writeFileSync(fake, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return { folder, fake };
}

function run(args, extraEnv = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [harness, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv }
  });
}

test("explicit Markdown wins without calling the classifier", () => {
  const result = run(["route", "show me a dashboard", "markdown"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    mode: "markdown",
    source: "explicit-override",
    confidence: 1,
    reason: "caller-selected-presentation",
    criterion: "benefit-from-manipulating-structured-state",
    requiresBuilder: false
  });
});

test("an active artifact routes a follow-up to update-existing-ui", () => {
  const result = run(["route", "add eggs", "auto", "", '{"id":"grocery-list"}']);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "active-artifact");
});

test("low JEV confidence falls back to Markdown", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown+inline-ui",score:0.31}]}));');
  const result = run(["route", "organize groceries", "auto", "", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown");
  assert.equal(decision.reason, "classifier-confidence-below-threshold");
});

test("a confident known JEV candidate selects inline UI", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown+inline-ui",score:0.91}]}));');
  const result = run(["route", "keep a grocery list", "auto", "milk and eggs", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown+inline-ui");
  assert.equal(decision.source, "classifier");
  assert.equal(decision.confidence, 0.91);
});

test("ask deterministically runs a confident complete playbook before the model", () => {
  const { folder, fake } = makeFakeAux4(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
const command = args.join(" ");
if (command.includes("config get")) process.stdout.write("{}\\n");
else if (command.includes("playbook hook-before")) process.stdout.write("Playbook match: groceries (confidence 0.9)\\nParams: item\\nRun: aux4 ai skill playbook run --id groceries --params '{\\\"item\\\":\\\"milk\\\"}'\\n");
else if (command.includes("playbook run")) process.stdout.write("Added milk to groceries\\n");
else if (command.includes("playbook hook-after")) process.stdout.write("");
else if (command.includes("ai agent ask")) { process.stderr.write("model must not run"); process.exit(9); }
`);
  const log = path.join(folder, "calls.log");
  const result = run([
    "ask", "add milk to groceries", "default", "", "config.yaml", "", "", "", "", '{"budget":{"calls":60}}', "", "json", "markdown", "", "", ".agent/playbooks", "0.15", "0.55", "jev-1.13.0", "", "", "", "", path.resolve(harness, "../..")
  ], { AUX4_BIN: fake, CALL_LOG: log }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Added milk to groceries");
  assert.equal(envelope.execution.source, "playbook");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.match(calls[0].join(" "), /playbook hook-before/);
  assert.match(calls[1].join(" "), /playbook run/);
  assert.match(calls[2].join(" "), /playbook hook-after/);
  assert.equal(calls.some(args => args.join(" ").includes("ai agent ask")), false);
});

test("ask calls hook-after after model completion and keeps its save suggestion", () => {
  const { folder, fake } = makeFakeAux4(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
const command = args.join(" ");
if (command.includes("config get")) process.stdout.write("{}\\n");
else if (command.includes("playbook hook-before")) process.stdout.write("");
else if (command.includes("ai agent ask")) process.stdout.write("Finished the task\\n");
else if (command.includes("playbook hook-after")) process.stdout.write('Save this as a playbook? Reply "save it".\\n');
`);
  const log = path.join(folder, "calls.log");
  const result = run([
    "ask", "perform a repeatable task", "default", "", "config.yaml", "", "", "", "", '{"budget":{"calls":60}}', "", "text", "markdown", "", "", ".agent/playbooks", "0.15", "0.55", "jev-1.13.0", "", "", "", "", path.resolve(harness, "../..")
  ], { AUX4_BIN: fake, CALL_LOG: log }, folder);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Finished the task\n\nSave this as a playbook/);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const modelIndex = calls.findIndex(args => args.join(" ").includes("ai agent ask"));
  const afterIndex = calls.findIndex(args => args.join(" ").includes("playbook hook-after"));
  assert.ok(modelIndex >= 0 && afterIndex > modelIndex);
});
