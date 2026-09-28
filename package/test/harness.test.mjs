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
    request: "build an editable packing checklist", conversation: "default", config: "", configFile: "config.yaml",
    instructions: "", skills: "", image: "", tools: "", policy: '{"budget":{"calls":60}}',
    permissions: "", output: "json", presentation: "markdown+inline-ui", conversationContext: "passport and charger",
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

const activeBudgetArtifact = {
  ...artifact,
  id: "local/agent-ui-demo/monthly-budget-42",
  ref: "artifact://agent-ui-demo/monthly-budget-42",
  key: "tracker:budget:monthly",
  aliases: ["monthly budget"],
  revision: 3,
  title: "Monthly budget",
  state: {
    categories: [
      { id: "housing", name: "Housing", amount: 1800 },
      { id: "travel", name: "Travel", amount: 250 }
    ]
  }
};

const budgetTransformation = {
  version: 1,
  transformationId: "budget-category-3",
  mode: "modify",
  source: {
    id: activeBudgetArtifact.id,
    ref: activeBudgetArtifact.ref,
    key: activeBudgetArtifact.key,
    revision: activeBudgetArtifact.revision
  },
  artifact: {
    ...activeBudgetArtifact,
    title: "Monthly budget by category",
    state: {
      categories: [
        ...activeBudgetArtifact.state.categories,
        { id: "food", name: "Food", amount: 400 }
      ]
    }
  }
};

const packingTransformation = {
  version: 1,
  transformationId: "packing-create-1",
  mode: "create",
  artifact: {
    ...artifact,
    id: "builder://packing-checklist",
    ref: "builder://packing-checklist",
    key: "checklist:packing:conference",
    aliases: ["conference packing checklist"],
    title: "Conference packing",
    state: {
      items: [
        { id: "passport", name: "Passport", completed: false },
        { id: "charger", name: "Charger", completed: false }
      ]
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

test("JEV selects update-existing-ui for a state-changing active-artifact follow-up", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"update-existing-ui",score:0.94}]}));');
  const result = run(["route", "move the card to done", "auto", "", '{"id":"project-board"}'], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "classifier");
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

test("a show request does not reuse incomplete active artifact metadata", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"update-existing-ui",score:0.88}]}));');
  const result = run(["route", "Display the current record", "auto", "", '{"id":"project-board","ref":"builder://project-board"}'], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "update-existing-ui");
  assert.equal(decision.source, "classifier");
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
  assert.equal(envelope.content, "Here’s the current interactive view.");
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

test("an explanation request does not reuse or update the active artifact", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown",score:0.92}]}));');
  const result = run(["route", "Explain how to change the current artifact", "auto", "", JSON.stringify(artifact)], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown");
  assert.equal(decision.source, "classifier");
  assert.equal(decision.requiresBuilder, false);
  assert.equal(decision.reuseActiveArtifact, undefined);
});

test("low JEV confidence falls back to Markdown", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown+inline-ui",score:0.31}]}));');
  const result = run(["route", "organize groceries", "auto", "", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown");
  assert.equal(decision.reason, "classifier-confidence-below-threshold");
});

test("a new structured interface is selected by JEV instead of domain shortcuts", () => {
  const { folder, fake } = makeFakeAux4(`
const fs = require("node:fs");
fs.writeFileSync(process.env.CALL_LOG, "classifier-called");
process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown+inline-ui",score:0.93}]}));
`);
  const log = path.join(folder, "calls.log");
  const result = run([
    "route", "Create a separate packing checklist for a winter trip", "auto", "", "", "0.55"
  ], { AUX4_BIN: fake, CALL_LOG: log });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown+inline-ui");
  assert.equal(decision.source, "classifier");
  assert.equal(decision.requiresBuilder, true);
  assert.equal(fs.readFileSync(log, "utf8"), "classifier-called");
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

test("cross-domain create and modify decisions come only from the generic classifier contract", () => {
  const cases = [
    {
      request: "Build a packing checklist for the conference",
      selected: "markdown+inline-ui",
      active: ""
    },
    {
      request: "Move the launch card to shipped status",
      selected: "update-existing-ui",
      active: JSON.stringify({ ...artifact, id: "release-board", ref: "artifact://agent/release-board", revision: 4 })
    },
    {
      request: "Track my workout plan by day",
      selected: "markdown+inline-ui",
      active: ""
    },
    {
      request: "Put travel under a separate budget category",
      selected: "update-existing-ui",
      active: JSON.stringify({ ...artifact, id: "monthly-budget", ref: "artifact://agent/monthly-budget", revision: 2 })
    }
  ];

  for (const fixture of cases) {
    const { folder, fake } = makeFakeAux4(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CALL_LOG, JSON.stringify(args));
process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:process.env.SELECTED_MODE,score:0.96}]}));
`);
    const log = path.join(folder, "calls.json");
    const result = run(["route", fixture.request, "auto", "", fixture.active, "0.55"], {
      AUX4_BIN: fake,
      CALL_LOG: log,
      SELECTED_MODE: fixture.selected
    });
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.mode, fixture.selected);
    assert.equal(decision.source, "classifier");
    assert.equal(decision.requiresBuilder, true);

    const args = JSON.parse(fs.readFileSync(log, "utf8"));
    const blocks = JSON.parse(args[args.indexOf("--blocks") + 1]);
    assert.equal(blocks.some(block => block.id === "update-existing-ui"), Boolean(fixture.active));
  }
});

test("an active artifact explanation stays Markdown when JEV selects prose", () => {
  const { fake } = makeFakeAux4('process.stdout.write(JSON.stringify({scale:"probability",blocks:[{id:"markdown",score:0.97}]}));');
  const result = run(["route", "Explain the totals in this view", "auto", "", JSON.stringify(activeGroceryArtifact)], {
    AUX4_BIN: fake
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.mode, "markdown");
  assert.equal(decision.source, "classifier");
  assert.equal(decision.requiresBuilder, false);
});

test("classifier failure conservatively falls back to Markdown without domain shortcuts", () => {
  const { fake } = makeFakeAux4('process.stderr.write("broker unavailable"); process.exit(2);');
  const result = run(["route", "Keep a grocery list with milk and eggs", "auto", "", "", "0.55"], { AUX4_BIN: fake });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    mode: "markdown",
    source: "fallback",
    confidence: 0,
    reason: "classifier-unavailable",
    criterion: "benefit-from-manipulating-structured-state",
    requiresBuilder: false
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
    request: "build an editable packing checklist",
    context: "passport and charger",
    decisions: { backend: "aux4/todo" },
    auto: true,
    steps: 10
  });
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
});

test("valid create and modify transformations pass through unchanged and are never executed", () => {
  for (const [transformation, activeArtifact] of [
    [packingTransformation, ""],
    [budgetTransformation, JSON.stringify(activeBudgetArtifact)]
  ]) {
    const { folder, fake } = makeBuilderFake();
    const log = path.join(folder, "calls.log");
    const result = run(askArgs({
      presentation: transformation.mode === "modify" ? "update-existing-ui" : "markdown+inline-ui",
      activeArtifact
    }), {
      AUX4_BIN: fake,
      CALL_LOG: log,
      BUILDER_OUTPUT: JSON.stringify({
        status: "done",
        reason: "Typed transformation ready.",
        artifactTransformation: transformation
      })
    }, folder);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.artifacts, []);
    assert.deepEqual(envelope.artifactTransformation, transformation);
    assert.deepEqual(envelope.builder, { status: "done" });
  }
});

test("ambiguous, stale, identity-changing, and path-operation transformations are rejected", () => {
  const invalid = [
    { status: "done", artifact, artifactTransformation: budgetTransformation },
    { status: "done", artifactTransaction: splitTransaction, artifactTransformation: budgetTransformation },
    { status: "done", artifactTransformation: { ...budgetTransformation, transformationId: "bad id" } },
    {
      status: "done",
      artifactTransformation: {
        ...budgetTransformation,
        source: { ...budgetTransformation.source, revision: 2 }
      }
    },
    {
      status: "done",
      artifactTransformation: {
        ...budgetTransformation,
        artifact: { ...budgetTransformation.artifact, id: "different-id" }
      }
    },
    {
      status: "done",
      artifactTransformation: { ...packingTransformation, source: budgetTransformation.source }
    },
    {
      status: "done",
      artifactTransformation: {
        ...packingTransformation,
        artifact: { ...packingTransformation.artifact, revision: 1 }
      }
    },
    {
      status: "done",
      artifactTransformation: {
        ...budgetTransformation,
        operations: [{ op: "replace", path: "/state/categories/0", value: {} }]
      }
    }
  ];

  for (const output of invalid) {
    const { folder, fake } = makeBuilderFake();
    const log = path.join(folder, "calls.log");
    const result = run(askArgs({
      presentation: "update-existing-ui",
      activeArtifact: JSON.stringify(activeBudgetArtifact)
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

test("a successful UI build preserves the accompanying written response", () => {
  const { folder, fake } = makeBuilderFake();
  const log = path.join(folder, "calls.log");
  const semanticArtifact = {
    ...artifact,
    key: "list:grocery:picnic",
    aliases: ["picnic grocery list", "picnic grocery"]
  };
  const result = run(askArgs({
    request: "Create an interactive trip planner",
    presentation: "markdown+inline-ui"
  }), {
    AUX4_BIN: fake,
    CALL_LOG: log,
    BUILDER_OUTPUT: JSON.stringify({ status: "done", artifact: semanticArtifact })
  }, folder);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.content, "Here is your written answer.");
  assert.equal(envelope.presentation.source, "explicit-override");
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
    assert.deepEqual(envelope.artifacts, []);
    assert.equal(envelope.builder.code, "BUILDER_INVALID_OUTPUT");
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
