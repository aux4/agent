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

function askArgs(overrides = {}) {
  const values = {
    request: "build a grocery list", conversation: "default", config: "", configFile: "config.yaml",
    instructions: "", skills: "", image: "", tools: "", policy: '{"budget":{"calls":60}}',
    permissions: "", output: "json", presentation: "markdown+inline-ui", conversationContext: "milk and eggs",
    activeArtifact: "", playbookFolder: ".agent/playbooks", playbookThreshold: "0.15",
    classifierThreshold: "0.55", classifyModel: "jev-1.13.0", classifyBaseUrl: "", classifyApiKey: "",
    brokerUrl: "", brokerToken: "", packageDir: path.resolve(harness, "../.."), builderAdapter: "local",
    builderVm: "builder", builderScope: "", builderApiUrl: "https://api.aux4.cloud",
    builderTimeoutMs: "120000", builderDecisions: "", builderBackends: "", builderAuto: "true",
    builderSteps: "10", builderModel: ""
  };
  Object.assign(values, overrides);
  return ["ask", values.request, values.conversation, values.config, values.configFile, values.instructions,
    values.skills, values.image, values.tools, values.policy, values.permissions, values.output,
    values.presentation, values.conversationContext, values.activeArtifact, values.playbookFolder,
    values.playbookThreshold, values.classifierThreshold, values.classifyModel, values.classifyBaseUrl,
    values.classifyApiKey, values.brokerUrl, values.brokerToken, values.packageDir, values.builderAdapter,
    values.builderVm, values.builderScope, values.builderApiUrl, values.builderTimeoutMs,
    values.builderDecisions, values.builderBackends, values.builderAuto, values.builderSteps, values.builderModel];
}

function makeBuilderFake() {
  return makeFakeAux4(`
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args,input}) + "\\n");
const command = args.join(" ");
if (command.includes("config get")) process.stdout.write("{}\\n");
else if (command.includes("playbook hook-before")) process.stdout.write("");
else if (command.includes("ai agent ask")) process.stdout.write("Here is your written answer.\\n");
else if (command.includes("playbook hook-after")) process.stdout.write("");
else if (command === "agent builder build" || command.startsWith("cloud ")) {
  if (process.env.BUILDER_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BUILDER_DELAY_MS));
  process.stdout.write(process.env.BUILDER_OUTPUT || "");
}
`);
}

const artifact = {
  id: "artifact-groceries",
  kind: "aux4.app",
  version: 1,
  presentation: "inline",
  ref: "builder://artifact-groceries",
  title: "Groceries",
  schema: { type: "List", props: { field: "items" } },
  state: {},
  data: {
    app: { routes: { "/": { type: "List", props: { field: "items" } } } },
    package: { scope: "generated", name: "grocery-list", profiles: [] }
  }
};

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

test("an obvious mutable list uses deterministic UI fallback when JEV is unavailable", () => {
  const { fake } = makeFakeAux4('process.stderr.write("broker unavailable"); process.exit(2);');
  const result = run(["route", "Keep a grocery list with milk and eggs", "auto", "", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    mode: "markdown+inline-ui",
    source: "deterministic-fallback",
    confidence: 1,
    reason: "obvious-mutable-structured-state-intent",
    criterion: "benefit-from-manipulating-structured-state",
    requiresBuilder: true
  });
});

test("an answer about a list remains Markdown when JEV is unavailable", () => {
  const { fake } = makeFakeAux4('process.exit(2);');
  const result = run(["route", "Explain how to organize a grocery list", "auto", "", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown");
  assert.equal(decision.reason, "classifier-unavailable");
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

test("Markdown mode never invokes the builder", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({ presentation: "markdown" }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, []);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.some(call => call.args.join(" ").includes("builder build")), false);
});

test("inline UI uses local builder argv and preserves Markdown content", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({ builderDecisions: '{"backend":"aux4/todo"}' }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", reason: "built", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Here is your written answer.");
  assert.deepEqual(envelope.artifacts, [artifact]);
  assert.deepEqual(envelope.builder, { status: "done" });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const builder = calls.find(call => call.args.join(" ") === "agent builder build");
  assert.ok(builder);
  assert.deepEqual(JSON.parse(builder.input), {
    request: "build a grocery list",
    context: "milk and eggs",
    decisions: { backend: "aux4/todo" },
    auto: true,
    steps: 10
  });
});

test("app proposal builds an artifact but never auto-deploys", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({ presentation: "markdown+app-proposal", request: "make this into an app" }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.deployment, { status: "proposal", automatic: false, requiresConfirmation: true });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.some(call => /deploy/.test(call.args.join(" "))), false);
});

test("update-existing-ui uses cloud argv and retains stable id and ref", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const current = { id: "stable-id", ref: "builder://stable-id", title: "Existing" };
  const changed = { ...artifact, id: "wrong-id", ref: "builder://wrong-id", title: "Updated" };
  const result = run(askArgs({
    presentation: "update-existing-ui",
    request: "add eggs",
    activeArtifact: JSON.stringify(current),
    builderAdapter: "cloud",
    builderVm: "builder",
    builderScope: "acme",
    builderApiUrl: "https://dev.api.aux4.cloud"
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact: changed })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.artifacts[0].id, "stable-id");
  assert.equal(envelope.artifacts[0].ref, "builder://stable-id");
  assert.equal(envelope.artifacts[0].title, "Updated");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const builder = calls.find(call => call.args[0] === "cloud");
  assert.deepEqual(builder.args, ["cloud", "builder", "generate", "--scope", "acme", "--apiUrl", "https://dev.api.aux4.cloud"]);
  const payload = JSON.parse(builder.input);
  assert.equal(payload.currentRef, "builder://stable-id");
  assert.equal(payload.currentArtifact, undefined);
});

test("needs-decision returns the partial typed artifact and a machine-readable question", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const decisions = [{ id: "backend", question: "Which list should store these items?", options: [{ value: "groceries" }] }];
  const result = run(askArgs(), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({
      status: "needs-decision",
      reason: '1 decision(s) need agent input -- answer with --decide <id>=<value> | validate: {"valid":true}',
      artifact,
      decisions
    })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, [artifact]);
  assert.equal(envelope.builder.status, "needs-decision");
  assert.deepEqual(envelope.builder.decisions, decisions);
  assert.match(envelope.content, /I need one choice before I can finish the interactive view\.[\s\S]*Which list should store these items\?/);
  assert.doesNotMatch(envelope.content, /--decide|validate/);
  assert.match(envelope.builder.reason, /--decide/);
});

test("malformed builder output safely degrades without exposing stderr", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs(), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: "not-json secret-token"
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, []);
  assert.deepEqual(envelope.builder, { status: "error", code: "BUILDER_INVALID_OUTPUT" });
  assert.doesNotMatch(envelope.content, /secret-token/);
});

test("builder timeout safely degrades with a structured code", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({ builderTimeoutMs: "1000" }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_DELAY_MS: "1500",
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.builder, { status: "error", code: "BUILDER_TIMEOUT" });
});
