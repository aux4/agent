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
    builderTimeoutMs: "120000", builderDecisions: "", builderBackends: "", builderBackendCatalog: "", builderAuto: "true",
    builderSteps: "10", builderModel: ""
  };
  Object.assign(values, overrides);
  return ["ask", values.request, values.conversation, values.config, values.configFile, values.instructions,
    values.skills, values.image, values.tools, values.policy, values.permissions, values.output,
    values.presentation, values.conversationContext, values.activeArtifact, values.playbookFolder,
    values.playbookThreshold, values.classifierThreshold, values.classifyModel, values.classifyBaseUrl,
    values.classifyApiKey, values.brokerUrl, values.brokerToken, values.packageDir, values.builderAdapter,
    values.builderVm, values.builderScope, values.builderApiUrl, values.builderTimeoutMs,
    values.builderDecisions, values.builderBackends, values.builderBackendCatalog, values.builderAuto, values.builderSteps, values.builderModel];
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
else if (command.includes("ai agent ask")) process.stdout.write((process.env.MODEL_OUTPUT || "Here is your written answer.") + "\\n");
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

function checklistArtifact({ id, ref, key, aliases, revision, title, items }) {
  const schema = {
    type: "Page",
    children: [{
      type: "Checklist",
      props: { field: "items", label: title, reorderable: true }
    }]
  };
  return {
    ...artifact,
    id,
    ref,
    key,
    aliases,
    ...(revision !== undefined ? { revision } : {}),
    title,
    schema,
    state: { items },
    data: {
      app: { routes: { "/": schema } },
      package: { scope: "generated", name: key.replaceAll(":", "-"), profiles: [] }
    }
  };
}

const sourceItems = [
  { id: "water", name: "water", completed: false },
  { id: "banana", name: "banana", completed: false },
  { id: "onion", name: "onion", completed: false },
  { id: "parsley", name: "parsley", completed: false },
  { id: "cilantro", name: "cilantro", completed: false },
  { id: "egg", name: "Egg", completed: false },
  { id: "milk", name: "Milk", completed: false }
];

const activeBreakfastArtifact = checklistArtifact({
  id: "local/agent-ui-demo/list-grocery-breakfast-42",
  ref: "artifact://agent-ui-demo/list-grocery-breakfast-42",
  key: "list:grocery:breakfast",
  aliases: ["breakfast grocery list", "breakfast groceries"],
  revision: 7,
  title: "Breakfast grocery list",
  items: sourceItems
});

const activeGroceryArtifact = checklistArtifact({
  id: "local/agent-ui-demo/list-grocery-eeef28dea0",
  ref: "artifact://agent-ui-demo/list-grocery-eeef28dea0",
  key: "list:grocery",
  aliases: ["grocery list", "grocery", "my grocery list"],
  revision: 7,
  title: "Grocery list",
  items: sourceItems
});

const groceryTransformation = {
  version: 1,
  transformationId: "grocery-layout-7",
  mode: "modify",
  source: {
    id: activeGroceryArtifact.id,
    ref: activeGroceryArtifact.ref,
    key: activeGroceryArtifact.key,
    revision: activeGroceryArtifact.revision
  },
  artifact: {
    ...activeGroceryArtifact,
    title: "Grocery list by aisle"
  }
};

const activeZipArtifact = {
  id: "local/agent-ui-demo/agent-action-77fdfe8fd7ef46d0-d341520c2e",
  kind: "aux4.app",
  version: 1,
  presentation: "inline",
  ref: "artifact://agent-ui-demo/agent-action-77fdfe8fd7ef46d0-d341520c2e",
  title: "ZIP Code Lookup",
  schema: { type: "Form" },
  state: { zipCode: "", city: "" },
  data: {
    source: "agent-action-broker",
    runtime: {
      version: 1,
      broker: "agent",
      actions: ["run"],
      request: "look up a ZIP code",
      operation: "Given the zip code, return the city.",
      inputField: "zipCode",
      outputField: "city",
      handler: { type: "us-zip-city", timeoutMs: 8000 }
    }
  }
};

const splitTransaction = {
  transactionId: "split-grocery-7",
  source: {
    id: activeGroceryArtifact.id,
    ref: activeGroceryArtifact.ref,
    key: activeGroceryArtifact.key,
    revision: activeGroceryArtifact.revision
  },
  operations: [
    {
      type: "create",
      key: "list:grocery:pavilions",
      aliases: ["Pavilions Grocery list", "Pavilions Grocery"],
      artifact: checklistArtifact({
        id: "local/list-grocery-pavilions",
        ref: "builder://local/list-grocery-pavilions",
        key: "list:grocery:pavilions",
        aliases: ["Pavilions Grocery list", "Pavilions Grocery"],
        title: "Pavilions Grocery list",
        items: sourceItems.filter(item => ["onion", "parsley", "cilantro", "egg"].includes(item.id))
      })
    },
    {
      type: "create",
      key: "list:grocery:costco",
      aliases: ["Costco Grocery list", "Costco Grocery"],
      artifact: checklistArtifact({
        id: "local/list-grocery-costco",
        ref: "builder://local/list-grocery-costco",
        key: "list:grocery:costco",
        aliases: ["Costco Grocery list", "Costco Grocery"],
        title: "Costco Grocery list",
        items: sourceItems.filter(item => ["water", "banana", "milk"].includes(item.id))
      })
    },
    {
      type: "delete",
      id: activeGroceryArtifact.id,
      revision: activeGroceryArtifact.revision
    }
  ]
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

test("a retry after a UI refusal routes through the inline builder", () => {
  const context = "user: Can you create a custom UI with a ZIP code input?\nassistant: I cannot create a custom UI or interactive widget. My interface is limited to text and the tools I have access to.";
  const result = run(["route", "You can do it, try again", "auto", context]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown+inline-ui");
  assert.equal(decision.source, "explicit-request");
  assert.equal(decision.requiresBuilder, true);
});

test("displaying a UI with an input field routes through the inline builder", () => {
  const result = run(["route", "Can you display an ui where I can enter the zip code and it shows the city", "auto"]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown+inline-ui");
  assert.equal(decision.source, "explicit-request");
  assert.equal(decision.requiresBuilder, true);
});

test("a plural ZIP/cities update keeps the active brokered artifact", () => {
  const result = run(["route", "Can show a list of possible cities, some zip codes may return more than one, update the ui", "auto", "", JSON.stringify(activeZipArtifact)]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "active-artifact");
  assert.equal(decision.requiresBuilder, true);
});

test("a brokered artifact is upgraded to the builder's complete artifact contract", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "Move the cities below the Find city button",
    presentation: "update-existing-ui",
    activeArtifact: JSON.stringify(activeZipArtifact)
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "error", reason: "fixture" })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const builder = calls.find(call => call.args.join(" ") === "agent builder build");
  assert.ok(builder);
  const payload = JSON.parse(builder.input);
  assert.deepEqual(payload.currentArtifact.data.app.routes["/"], activeZipArtifact.schema);
  assert.equal(payload.currentArtifact.data.package.scope, "local");
  assert.match(payload.currentArtifact.data.package.name, /^[a-z0-9-]+$/);
  assert.deepEqual(payload.currentArtifact.data.runtime, activeZipArtifact.data.runtime);
  assert.equal(payload.currentArtifact.data.source, undefined);
});

test("an active artifact routes a follow-up to update-existing-ui", () => {
  const result = run(["route", "add eggs", "auto", "", '{"id":"grocery-list"}']);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "active-artifact");
});

test("corrective feedback about the current UI routes back to the builder", () => {
  const result = run(["route", "That's not a grocery list UI", "auto", "", JSON.stringify(artifact)]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "active-artifact");
  assert.equal(decision.requiresBuilder, true);
});

test("a show request deterministically reuses a complete active artifact", () => {
  const result = run(["route", "Show me the list", "auto", "", JSON.stringify(artifact)]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    mode: "markdown+inline-ui",
    source: "active-artifact-reuse",
    confidence: 1,
    reason: "show-existing-active-artifact",
    criterion: "benefit-from-manipulating-structured-state",
    requiresBuilder: false,
    reuseActiveArtifact: true
  });
});

test("a named canonical list view reuses the resolved active artifact", () => {
  const result = run(["route", "Show my breakfast grocery list", "auto", "", JSON.stringify(activeBreakfastArtifact)]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.source, "active-artifact-reuse");
  assert.equal(decision.requiresBuilder, false);
  assert.equal(decision.reuseActiveArtifact, true);
});

test("a named list view with an inline UI qualifier reuses the active artifact", () => {
  const result = run(["route", "Show my grocery list on an interactive UI", "auto", "", JSON.stringify(artifact)]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.source, "active-artifact-reuse");
  assert.equal(decision.requiresBuilder, false);
  assert.equal(decision.reuseActiveArtifact, true);
});

test("a show request does not reuse incomplete active artifact metadata", () => {
  const result = run(["route", "Show me the list", "auto", "", '{"id":"grocery-list","ref":"builder://grocery-list"}']);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "active-artifact");
  assert.equal(decision.requiresBuilder, true);
  assert.equal(decision.reuseActiveArtifact, undefined);
});

test("ask re-emits the exact active artifact without invoking aux4", () => {
  const current = {
    ...artifact,
    state: { items: [{ id: "milk", label: "Milk" }, { id: "eggs", label: "Eggs" }] }
  };
  const { folder, fake } = makeFakeAux4(`
const fs = require("node:fs");
fs.appendFileSync(process.env.CALL_LOG, "called\\n");
process.stderr.write("aux4 must not run");
process.exit(9);
`);
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "Could you please show me the list?",
    presentation: "auto",
    activeArtifact: JSON.stringify(current)
  }), { AUX4_BIN: fake, CALL_LOG: log }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Here’s the list.");
  assert.equal(envelope.presentation.source, "active-artifact-reuse");
  assert.equal(envelope.presentation.requiresBuilder, false);
  assert.deepEqual(envelope.artifacts, [current]);
  assert.deepEqual(envelope.execution, { source: "active-artifact-reuse" });
  assert.equal(fs.existsSync(log), false);
});

test("ask preserves canonical identity and revision for a named list view without invoking aux4", () => {
  const { folder, fake } = makeFakeAux4(`
process.stderr.write("aux4 must not run");
process.exit(9);
`);
  const result = run(askArgs({
    request: "Show my breakfast grocery list",
    presentation: "auto",
    activeArtifact: JSON.stringify(activeBreakfastArtifact)
  }), { AUX4_BIN: fake }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, [activeBreakfastArtifact]);
  assert.equal(envelope.artifacts[0].revision, 7);
  assert.equal(envelope.builder, undefined);
  assert.equal(envelope.presentation.reuseActiveArtifact, true);
});

test("a show-shaped mutation does not reuse the active artifact", () => {
  const result = run(["route", "Show me how to edit the list", "auto", "", JSON.stringify(artifact)]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "active-artifact");
  assert.equal(decision.requiresBuilder, true);
  assert.equal(decision.reuseActiveArtifact, undefined);
});

test("an unrelated question with an active artifact stays Markdown", () => {
  const { fake } = makeFakeAux4('process.stderr.write("classifier must not run"); process.exit(9);');
  const result = run([
    "route", "What is the weather like today?", "auto",
    "user: Show me my grocery list\\nassistant: Here it is.", JSON.stringify(artifact)
  ], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown");
  assert.equal(decision.source, "active-artifact-prose-guard");
  assert.equal(decision.reason, "current-request-is-unrelated-prose");
  assert.equal(decision.requiresBuilder, false);
});

test("a short imperative mutation still updates the active artifact", () => {
  const result = run(["route", "add eggs", "auto", "", JSON.stringify(artifact)]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "active-artifact");
  assert.equal(decision.requiresBuilder, true);
});

test("low JEV confidence falls back to Markdown", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown+inline-ui",score:0.31}]}));');
  const result = run(["route", "organize groceries", "auto", "", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown");
  assert.equal(decision.reason, "classifier-confidence-below-threshold");
});

test("an explicit separate collection routes to UI without consulting JEV", () => {
  const { folder, fake } = makeFakeAux4(`
const fs = require("node:fs");
fs.writeFileSync(process.env.CALL_LOG, "classifier-called");
process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown",score:0.99}]}));
`);
  const log = path.join(folder, "calls.log");
  const result = run([
    "route", "Create a separate picnic grocery list with juice and apples", "auto", "", "", "0.55"
  ], { AUX4_BIN: fake, CALL_LOG: log });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown+inline-ui");
  assert.equal(decision.source, "explicit-request");
  assert.equal(decision.requiresBuilder, true);
  assert.equal(fs.existsSync(log), false);
});

test("a confident known JEV candidate selects inline UI", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown+inline-ui",score:0.91}]}));');
  const result = run(["route", "keep a grocery list", "auto", "milk and eggs", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown+inline-ui");
  assert.equal(decision.source, "deterministic-mutable-state");
  assert.equal(decision.confidence, 1);
});

test("automatic presentation classification runs in parallel with the answer model", () => {
  const { folder, fake } = makeFakeAux4(`
const args = process.argv.slice(2);
const command = args.join(" ");
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (command.includes("config get")) process.stdout.write("{}\\n");
else if (command.includes("playbook hook-before") || command.includes("playbook hook-after")) process.stdout.write("");
else if (command.includes("classify rank")) { wait(600); process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown",score:0.95}]})); }
else if (command.includes("ai agent ask")) { wait(600); process.stdout.write("Parallel answer\\n"); }
`);
  const started = Date.now();
  const result = run(askArgs({
    request: "Organize these thoughts for me",
    presentation: "auto"
  }), { AUX4_BIN: fake }, folder);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).content, "Parallel answer");
  assert.ok(elapsed < 1050, `expected parallel execution, got ${elapsed}ms`);
});

test("an obvious mutable list uses deterministic UI fallback when JEV is unavailable", () => {
  const { fake } = makeFakeAux4('process.stderr.write("broker unavailable"); process.exit(2);');
  const result = run(["route", "Keep a grocery list with milk and eggs", "auto", "", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    mode: "markdown+inline-ui",
    source: "deterministic-mutable-state",
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

test("inline UI uses local builder argv and replaces model prose with a confirmation", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({ builderDecisions: '{"backend":"aux4/todo"}' }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", reason: "built", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Here’s the interactive view.");
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

test("inline UI forwards the caller's portable backend catalog", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const catalog = [{
    scope: "community",
    name: "records",
    description: "Manage records",
    commands: [{ path: ["records", "add"], helpText: "Add a record", variables: [] }]
  }];
  const result = run(askArgs({ builderBackendCatalog: JSON.stringify(catalog) }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", reason: "built", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const builder = calls.find(call => call.args.join(" ") === "agent builder build");
  assert.ok(builder);
  assert.deepEqual(JSON.parse(builder.input).backendCatalog, catalog);
});

test("inline UI replaces a contradictory model refusal when the builder returns an artifact", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({ request: "create a custom UI for entering a ZIP code" }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    MODEL_OUTPUT: "I cannot create a custom UI. My capabilities are limited to text-based communication.",
    BUILDER_OUTPUT: JSON.stringify({ status: "done", reason: "built", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Here’s the interactive view.");
  assert.deepEqual(envelope.artifacts, [artifact]);
});

test("a retry after a UI refusal sends the prior UI request to the builder", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "You can do it, try again",
    conversationContext: "user: Can you create a custom UI for entering a ZIP code?\nassistant: I cannot create a custom UI. My interface is limited to text."
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    MODEL_OUTPUT: "I cannot create a custom UI. My interface is limited to text.",
    BUILDER_OUTPUT: JSON.stringify({ status: "done", reason: "built", artifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Here’s the interactive view.");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const builder = calls.find(call => call.args.join(" ") === "agent builder build");
  assert.ok(builder);
  assert.equal(JSON.parse(builder.input).request, "Can you create a custom UI for entering a ZIP code?");
});

test("builder semantic key and bounded aliases survive the typed harness envelope", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const semanticArtifact = {
    ...artifact,
    key: "list:grocery",
    aliases: ["grocery list", "grocery", "my grocery list"]
  };
  const result = run(askArgs(), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact: semanticArtifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, [semanticArtifact]);
});

test("a valid builder transaction is preserved unchanged with an empty artifact list", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "Can you split my list into separate Pavilions and Costco lists, with eggs and vegetables at Pavilions and the rest at Costco",
    presentation: "update-existing-ui",
    activeArtifact: JSON.stringify(activeGroceryArtifact)
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({
      status: "done",
      reason: "Grocery list split into Pavilions and Costco.",
      artifactTransaction: splitTransaction
    })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, []);
  assert.deepEqual(envelope.artifactTransaction, splitTransaction);
  assert.deepEqual(envelope.builder, { status: "done" });
  assert.equal(envelope.content, "I updated the interactive view.");
});

test("a valid builder transformation is preserved unchanged with an empty artifact list", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "Move the grocery results below the button",
    presentation: "update-existing-ui",
    activeArtifact: JSON.stringify(activeGroceryArtifact)
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    MODEL_OUTPUT: "```html\n<div>speculative implementation</div>\n```",
    BUILDER_OUTPUT: JSON.stringify({
      status: "done",
      reason: "Layout updated.",
      artifactTransformation: groceryTransformation
    })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, []);
  assert.deepEqual(envelope.artifactTransformation, groceryTransformation);
  assert.deepEqual(envelope.builder, { status: "done" });
  assert.equal(envelope.content, "I updated the interactive view.");
  assert.doesNotMatch(envelope.content, /html|speculative implementation/);
});

test("stale and ambiguous builder transformations degrade to a safe builder error", () => {
  const invalidOutputs = [
    { status: "done", artifact, artifactTransformation: groceryTransformation },
    {
      status: "done",
      artifactTransformation: {
        ...groceryTransformation,
        source: { ...groceryTransformation.source, revision: 6 }
      }
    },
    {
      status: "done",
      artifactTransformation: {
        ...groceryTransformation,
        artifact: { ...groceryTransformation.artifact, id: "different-id" }
      }
    }
  ];

  for (const output of invalidOutputs) {
    const { folder, fake } = makeBuilderFake();
    const log = path.join(folder, "calls.log");
    const result = run(askArgs({
      presentation: "update-existing-ui",
      activeArtifact: JSON.stringify(activeGroceryArtifact)
    }), {
      AUX4_BIN: fake,
      CALL_LOG: log,
      BUILDER_OUTPUT: JSON.stringify(output)
    }, folder);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.artifacts, []);
    assert.equal(envelope.artifactTransformation, undefined);
    assert.deepEqual(envelope.builder, { status: "error", code: "BUILDER_INVALID_OUTPUT" });
  }
});

test("invalid or ambiguous builder transactions degrade to a safe builder error", () => {
  const invalidOutputs = [
    { status: "done", artifact, artifactTransaction: splitTransaction },
    { status: "done", artifact: null, artifactTransaction: splitTransaction },
    { status: "done", artifactTransaction: { ...splitTransaction, transactionId: "bad transaction id" } },
    {
      status: "done",
      artifactTransaction: {
        ...splitTransaction,
        source: { ...splitTransaction.source, revision: 8 }
      }
    },
    {
      status: "done",
      artifactTransaction: {
        ...splitTransaction,
        operations: [splitTransaction.operations[0], splitTransaction.operations[2], splitTransaction.operations[1]]
      }
    },
    {
      status: "done",
      artifactTransaction: {
        ...splitTransaction,
        operations: [
          {
            ...splitTransaction.operations[0],
            aliases: ["different alias"]
          },
          splitTransaction.operations[2]
        ]
      }
    }
  ];

  for (const output of invalidOutputs) {
    const { folder, fake } = makeBuilderFake();
    const log = path.join(folder, "calls.log");
    const result = run(askArgs({
      presentation: "update-existing-ui",
      activeArtifact: JSON.stringify(activeGroceryArtifact)
    }), {
      AUX4_BIN: fake,
      CALL_LOG: log,
      BUILDER_OUTPUT: JSON.stringify(output)
    }, folder);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.artifacts, []);
    assert.equal(envelope.artifactTransaction, undefined);
    assert.deepEqual(envelope.builder, { status: "error", code: "BUILDER_INVALID_OUTPUT" });
  }
});

test("a successful separate collection build replaces contradictory model prose", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const semanticArtifact = {
    ...artifact,
    key: "list:grocery:picnic",
    aliases: ["picnic grocery list", "picnic grocery"]
  };
  const result = run(askArgs({
    request: "Create a separate picnic grocery list with juice and apples",
    presentation: "auto"
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact: semanticArtifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Here’s the interactive view.");
  assert.equal(envelope.presentation.source, "explicit-request");
  assert.deepEqual(envelope.artifacts, [semanticArtifact]);
});

test("invalid semantic artifact metadata is rejected while legacy metadata remains optional", () => {
  for (const invalid of [
    { ...artifact, key: "bad key" },
    { ...artifact, key: "list:grocery", aliases: [""] },
    { ...artifact, key: "list:grocery", aliases: Array.from({ length: 17 }, (_, index) => `alias-${index}`) }
  ]) {
    const { folder, fake } = makeBuilderFake();
    const log = path.join(folder, "calls.log");
    const result = run(askArgs(), {
      AUX4_BIN: fake,
      CALL_LOG: log,
      BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact: invalid })
    }, folder);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.artifacts[0].schema.type, "Form");
    assert.deepEqual(envelope.builder, { status: "done", fallback: "agent-action-broker", code: "BUILDER_INVALID_OUTPUT" });
  }
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
  const current = {
    id: "stable-id", ref: "builder://stable-id", title: "Existing",
    key: "list:grocery", aliases: ["grocery list", "my grocery list"]
  };
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
  assert.equal(envelope.artifacts[0].key, "list:grocery");
  assert.deepEqual(envelope.artifacts[0].aliases, ["grocery list", "my grocery list"]);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const builder = calls.find(call => call.args[0] === "cloud");
  assert.deepEqual(builder.args, ["cloud", "builder", "generate", "--scope", "acme", "--apiUrl", "https://dev.api.aux4.cloud"]);
  const payload = JSON.parse(builder.input);
  assert.equal(payload.currentRef, "builder://stable-id");
  assert.equal(payload.currentArtifact, undefined);
});

test("an inline build with an unresolved backend preserves the builder artifact and decision", () => {
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
  assert.match(envelope.content, /I need one choice before I can finish the interactive view/);
});

test("needs-input preserves the active artifact without a false technical-error fallback", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const reason = "no part of the instruction could be resolved into an app screen/route";
  const result = run(askArgs({
    request: "Make the interactive version better",
    presentation: "update-existing-ui",
    activeArtifact: JSON.stringify(activeGroceryArtifact)
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "needs-input", reason, artifact: activeGroceryArtifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.artifacts[0].id, activeGroceryArtifact.id);
  assert.equal(envelope.artifacts[0].ref, activeGroceryArtifact.ref);
  assert.equal(envelope.artifacts[0].revision, activeGroceryArtifact.revision);
  assert.deepEqual(envelope.builder, { status: "needs-input", reason });
  assert.match(envelope.content, /I need a little more detail before I can finish the interactive view/);
  assert.doesNotMatch(envelope.content, /couldn't create or update|app screen\/route/);
});

test("malformed builder output safely degrades without exposing stderr", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({ request: "Can you display an ui where I can enter the zip code and it shows the city" }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: "not-json secret-token"
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.artifacts[0].schema.type, "Form");
  assert.equal(envelope.artifacts[0].title, "ZIP Code Lookup");
  assert.equal(envelope.artifacts[0].schema.props.submitLabel, "Find city");
  assert.equal(envelope.artifacts[0].schema.props.noSubmit, true);
  assert.deepEqual(envelope.artifacts[0].schema.children.map(child => child.props.label), ["ZIP code", "Find city", "City"]);
  assert.equal(envelope.artifacts[0].schema.children[1].type, "Button");
  assert.equal(envelope.artifacts[0].schema.children[2].type, "TextArea");
  assert.deepEqual(envelope.artifacts[0].state, { zipCode: "", city: "" });
  assert.equal(envelope.artifacts[0].data.runtime.operation, "Given the zip code, return the city.");
  assert.deepEqual(envelope.artifacts[0].data.runtime.handler, { type: "us-zip-city", timeoutMs: 8000 });
  assert.deepEqual(envelope.builder, { status: "done", fallback: "agent-action-broker", code: "BUILDER_INVALID_OUTPUT" });
  assert.doesNotMatch(envelope.content, /secret-token/);
});

test("a first-turn ZIP city list stays a result below the action when the builder needs input", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const request = "Can you create a form where I enter the zip code and it displays the list of cities for that zip code";
  const result = run(askArgs({ request }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({
      status: "needs-input",
      reason: "backend action needs clarification",
      artifact: activeZipArtifact
    })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.artifacts, [activeZipArtifact]);
  assert.deepEqual(envelope.builder, { status: "needs-input", reason: "backend action needs clarification" });
  assert.match(envelope.content, /I need a little more detail before I can finish the interactive view/);
});

test("an update fallback preserves the ZIP artifact and plural result label", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "Can show a list of possible cities, some zip codes may return more than one, update the ui",
    presentation: "auto",
    activeArtifact: JSON.stringify(activeZipArtifact),
    builderTimeoutMs: "1000"
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_DELAY_MS: "1500"
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  const updated = envelope.artifacts[0];
  assert.equal(updated.id, activeZipArtifact.id);
  assert.equal(updated.ref, activeZipArtifact.ref);
  assert.equal(updated.title, "ZIP Code Lookup");
  assert.equal(updated.schema.children[0].props.label, "ZIP code");
  assert.equal(updated.schema.props.noSubmit, true);
  assert.equal(updated.schema.children[1].type, "Button");
  assert.equal(updated.schema.children[2].type, "Box");
  assert.equal(updated.schema.children[2].children[0].props.text, "Cities");
  assert.equal(updated.schema.children[2].children[1].type, "Repeat");
  assert.deepEqual(updated.data.runtime.handler, { type: "us-zip-city", timeoutMs: 8000 });
  assert.deepEqual(envelope.builder, { status: "done", fallback: "agent-action-broker", code: "BUILDER_TIMEOUT" });
});

test("an update that only mentions cities reuses the existing ZIP operation", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "Can you update the ui to show a list of cities instead of only one, there are a few cases it returns more than one",
    presentation: "auto",
    activeArtifact: JSON.stringify(activeZipArtifact),
    builderTimeoutMs: "1000"
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_DELAY_MS: "1500"
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  const updated = envelope.artifacts[0];
  assert.equal(updated.title, "ZIP Code Lookup");
  assert.deepEqual(updated.schema.children.map(child => child.props?.field), ["zipCode", undefined, undefined]);
  assert.equal(updated.schema.children[0].props.label, "ZIP code");
  assert.equal(updated.schema.children[1].type, "Button");
  assert.equal(updated.schema.children[2].type, "Box");
  assert.equal(updated.schema.children[2].children[0].props.text, "Cities");
  assert.equal(updated.schema.children[2].children[1].type, "Repeat");
  assert.deepEqual(updated.schema.children[2].children[1].props, {
    field: "cities", gap: 8, empty: "No cities found."
  });
  assert.equal(updated.schema.children[2].children[1].children[0].children[0].type, "Label");
  assert.equal(updated.schema.children[2].children[1].children[0].children[0].props.field, "name");
  assert.deepEqual(updated.state, { zipCode: "", city: "", cities: [], citiesReady: false });
  assert.equal(updated.data.runtime.outputField, "cities");
  assert.deepEqual(updated.data.runtime.handler, { type: "us-zip-city", timeoutMs: 8000 });
});

test("the harness does not rewrite a successful builder artifact", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const result = run(askArgs({
    request: "Can you update the ui to show the cities in a list instead of a text area, if it returns multiple cities to the same zip code it should show all of them",
    presentation: "update-existing-ui",
    activeArtifact: JSON.stringify(activeZipArtifact)
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact: activeZipArtifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  const updated = envelope.artifacts[0];
  assert.equal(updated.id, activeZipArtifact.id);
  assert.deepEqual(updated.schema, activeZipArtifact.schema);
  assert.equal(updated.data.runtime.outputField, "city");
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
  assert.equal(envelope.artifacts[0].schema.type, "Form");
  assert.deepEqual(envelope.builder, { status: "done", fallback: "agent-action-broker", code: "BUILDER_TIMEOUT" });
});
