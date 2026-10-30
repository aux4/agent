import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  buildReadOnlyLookupRestrictions,
  parseReadOnlyLookupProposal
} from "../../lib/agent-loop.mjs";
import { buildContinuationArgs } from "../../lib/ask.mjs";

const aiAgentSource = process.env.AI_AGENT_SOURCE;

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function createLoader(file) {
  const source = [
    "import fs from 'node:fs';",
    "import { builtinModules, createRequire } from 'node:module';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    "const require = createRequire(pathToFileURL(process.env.AI_AGENT_SOURCE + '/package.json'));",
    "const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);",
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier.endsWith('?raw')) {",
    "    const raw = new URL(specifier.slice(0, -4), context.parentURL);",
    "    const content = fs.readFileSync(fileURLToPath(raw), 'utf8');",
    "    return { url: 'data:text/javascript,' + encodeURIComponent('export default ' + JSON.stringify(content) + ';'), shortCircuit: true };",
    "  }",
    "  if (builtins.has(specifier) || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {",
    "    return nextResolve(specifier, context);",
    "  }",
    "  try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }; } catch {}",
    "  return nextResolve(specifier, context);",
    "}"
  ].join("\n");
  fs.writeFileSync(file, source, "utf8");
  return file;
}

test("missing-fact lookup restrictions preserve the real AI policy and permission gates", {
  skip: !aiAgentSource ? "Set AI_AGENT_SOURCE to run this optional integration probe." : false
}, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "missing-fact-policy-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const aux4Log = path.join(tempDir, "aux4-argv.jsonl");
  const fakeAux4 = writeExecutable(path.join(tempDir, "aux4"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args.join(' ') === 'records list --help') {",
    "  process.stdout.write('List records\\n    --query <value>\\n    --sensitive <value>\\n    --action <value>\\n');",
    "} else {",
    "  fs.appendFileSync(process.env.AUX4_CAPTURE, JSON.stringify(args) + '\\n');",
    "  process.stdout.write('lookup complete\\n');",
    "}"
  ].join("\n"));

  const priorAux4Bin = process.env.AUX4_BIN;
  process.env.AUX4_BIN = fakeAux4;
  t.after(() => {
    if (priorAux4Bin === undefined) delete process.env.AUX4_BIN;
    else process.env.AUX4_BIN = priorAux4Bin;
  });
  const restrictions = buildReadOnlyLookupRestrictions({
    allow: ["records *"],
    deny: ["records list --blocked*"],
    ask: ["records list --sensitive*"],
    auditTag: "keep"
  }, ["aux4 records list"]);
  assert.ok(restrictions, "a documented, caller-allowed read leaf should be available");
  assert.deepEqual(restrictions.commands, ["records list"]);

  const normalProposal = parseReadOnlyLookupProposal(
    JSON.stringify({ lookupCommand: 'records list --query "items to delete"' }),
    restrictions.commands
  );
  assert.deepEqual(normalProposal, {
    command: 'records list --query "items to delete"',
    path: "records list"
  }, JSON.stringify({ restrictions, normalProposal }));
  assert.equal(parseReadOnlyLookupProposal(
    JSON.stringify({ lookupCommand: "records list --query x; records delete" }),
    restrictions.commands
  ), null, "compound shell syntax must be rejected before dispatch");
  assert.equal(parseReadOnlyLookupProposal(
    JSON.stringify({ lookupCommand: 'records list --query "$(touch marker)"' }),
    restrictions.commands
  ), null, "command substitution must be rejected before dispatch");
  assert.equal(parseReadOnlyLookupProposal(
    JSON.stringify({ lookupCommand: "records list --action delete" }),
    restrictions.commands
  ), null, "a mutation-selector option on a read-named leaf must be rejected");

  const originalPolicy = {
    allow: [{ executeAux4: ["records list *"] }],
    deny: [{ executeAux4: ["records delete *"] }],
    budget: { calls: 2 },
    escalate: [{ on: ["budget_exceeded"], mode: "notify" }]
  };
  const originalPolicySnapshot = structuredClone(originalPolicy);
  const continuationArgs = buildContinuationArgs({
    request: "lookup the requested record",
    configFile: "config.yaml",
    packageDir: "/package",
    tools: "executeAux4",
    permissions: restrictions.permissions,
    policy: JSON.stringify(originalPolicy)
  }, path.join(tempDir, "history.json"), normalProposal.command);
  const policyIndex = continuationArgs.indexOf("--policy");
  const permissionsIndex = continuationArgs.indexOf("--permissions");
  const toolsIndex = continuationArgs.indexOf("--tools");
  const toolCallIndex = continuationArgs.indexOf("--toolCall");
  assert.notEqual(policyIndex, -1);
  assert.deepEqual(JSON.parse(continuationArgs[policyIndex + 1]), originalPolicySnapshot);
  assert.equal(continuationArgs[toolsIndex + 1], "executeAux4");
  assert.deepEqual(JSON.parse(continuationArgs[permissionsIndex + 1]), JSON.parse(restrictions.permissions));
  assert.equal(JSON.parse(continuationArgs[toolCallIndex + 1]).name, "executeAux4");
  assert.equal(JSON.parse(continuationArgs[toolCallIndex + 1]).args.command, normalProposal.command);
  assert.deepEqual(originalPolicy, originalPolicySnapshot, "building temporary permissions must not mutate caller policy");

  const probe = path.join(tempDir, "ai-agent-probe.mjs");
  fs.writeFileSync(probe, [
    "import assert from 'node:assert/strict';",
    "import { pathToFileURL } from 'node:url';",
    "const source = process.env.AI_AGENT_SOURCE;",
    "const { Policy } = await import(pathToFileURL(source + '/src/lib/Policy.js'));",
    "const tools = await import(pathToFileURL(source + '/src/lib/Tools.js'));",
    "const permissions = JSON.parse(process.env.MISSING_FACT_PERMISSIONS);",
    "const policySpec = JSON.parse(process.env.MISSING_FACT_POLICY);",
    "const policySnapshot = JSON.stringify(policySpec);",
    "const policy = Policy.load(policySpec);",
    "assert.equal(policy.decide('executeAux4', { command: 'records list --query q' }, {}, 1).decision, 'allow');",
    "assert.equal(policy.decide('executeAux4', { command: 'records delete --id R-1' }, {}, 1).decision, 'deny');",
    "assert.equal(policy.escalateFor('budget_exceeded'), policySpec.escalate[0]);",
    "const budgetOne = Policy.load({ budget: { calls: 1 } });",
    "const budgetTwo = Policy.load({ budget: { calls: 2 } });",
    "assert.equal(budgetOne.decide('executeAux4', { command: 'records list --query q' }, {}, 1).decision, 'allow');",
    "assert.equal(budgetOne.decide('executeAux4', { command: 'records list --query q' }, {}, 2).trigger, 'budget_exceeded');",
    "assert.equal(budgetTwo.decide('executeAux4', { command: 'records list --query q' }, {}, 2).decision, 'allow');",
    "assert.equal(budgetTwo.decide('executeAux4', { command: 'records list --query q' }, {}, 3).trigger, 'budget_exceeded');",
    "assert.equal(tools.checkPermission('records list --query q', permissions), 'allow');",
    "assert.equal(tools.checkPermission('records delete --id R-1', permissions), 'deny');",
    "assert.equal(tools.checkPermission('records list --blocked id', permissions), 'deny');",
    "assert.equal(tools.checkPermission('records list --sensitive value', permissions), 'ask');",
    "assert.equal(tools.checkPermission('records list; touch marker', permissions), 'deny');",
    "assert.equal(tools.checkPermission('records list --query $(touch marker)', permissions), 'deny');",
    "assert.deepEqual(permissions.ask, ['records list --sensitive*']);",
    "assert(permissions.deny.some(pattern => pattern === 'records list --blocked*'));",
    "assert.equal(JSON.stringify(policySpec), policySnapshot);",
    "const guarded = tools.createExecuteAux4Tool(permissions);",
    "const safeOutput = await guarded.invoke({ command: 'records list --query q' });",
    "const compoundOutput = await guarded.invoke({ command: 'records list; touch ' + process.env.MISSING_FACT_MARKER });",
    "const substitutionOutput = await guarded.invoke({ command: 'records list --query \"$(touch ' + process.env.MISSING_FACT_MARKER + ')\"' });",
    "assert.match(String(safeOutput), /lookup complete/);",
    "assert.match(String(compoundOutput), /Permission denied/);",
    "assert.match(String(substitutionOutput), /Permission denied/);",
    "console.log(JSON.stringify({ safeOutput, compoundOutput, substitutionOutput }));"
  ].join("\n"), "utf8");

  const loader = createLoader(path.join(tempDir, "ai-agent-loader.mjs"));
  const marker = path.join(tempDir, "shell-ran");
  const aiAgentSourcePath = path.resolve(aiAgentSource);
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", loader, probe], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      AI_AGENT_SOURCE: aiAgentSourcePath,
      AUX4_CAPTURE: aux4Log,
      MISSING_FACT_PERMISSIONS: restrictions.permissions,
      MISSING_FACT_POLICY: JSON.stringify(originalPolicy),
      MISSING_FACT_MARKER: marker,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "AI-agent contract probe failed");
  assert.equal(fs.existsSync(marker), false, "shell text must never execute in the command process");
  assert.equal(fs.readFileSync(aux4Log, "utf8").trim().split("\n").length, 1, "only the safe read should reach aux4");
});
