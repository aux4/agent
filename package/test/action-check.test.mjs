import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeAction, actionCheckFiles, actionCheckStats, unsourcedActionIds } from "../lib/action-check.mjs";
import { writeCheckValuesHooksFile } from "../lib/agent-loop.mjs";

test("pre-action checks inherit the configured model, retain scope evidence, and record their cost", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-"));
  const original = process.env.AUX4_BIN;
  try {
    const log = path.join(dir, "args.json");
    const fake = path.join(dir, "aux4");
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
if (args.includes('--history')) fs.writeFileSync(args[args.indexOf('--history')+1], JSON.stringify({ messages: [{ role:'assistant', content:'verdict' }], tokenUsage: { input:123, output:12, cached:5 } }));
console.log(JSON.stringify({ allow:false, reason:'The selected record is explicitly excluded.' }));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const history = path.join(dir, "run.json");
    const options = { configFile: "/config/local.yaml", config: "local-small", packageDir: "/agent" };
    const attempts = [
      { command: "records list --query owner:Casey", source: '{"id":"r-19","owner":"Casey"}' },
      { command: "records delete --id r-19", completed: false, source: "" }
    ];
    assert.equal(authorizeAction(options, "records delete --id r-19", attempts,
      "Delete inactive records and leave Casey's records alone", history).allow, false);
    const args = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.equal(args[args.indexOf("--config") + 1], "local-small");
    assert.equal(args[args.indexOf("--configFile") + 1], "/config/local.yaml");
    assert.equal(args.includes("--hooks"), false);
    const payload = JSON.parse(args[args.indexOf("--question") + 1]);
    assert.match(payload.request, /leave Casey/);
    assert.match(payload.successfulActionsAndResults[0].result, /r-19/);
    assert.equal(payload.successfulActionsAndResults.length, 1);
    assert.equal(actionCheckFiles(history).length, 1);
    assert.equal(actionCheckStats(history).modelCalls, 1);
    assert.equal(actionCheckStats(history).input, 123);
    assert.deepEqual(actionCheckStats(history, new Set(actionCheckFiles(history))), {});
    assert.equal(authorizeAction(options, "records list", attempts).skipped, true);
    assert.equal(authorizeAction({ ...options, delegatedPrefixes: ['agent forms'] },
      'agent forms run --url https://example.test --goal "update the named record"').delegated, true);
    assert.equal(authorizeAction({ ...options, delegatedPrefixes: ['agent forms'] },
      'records delete --id r-19').allow, false);
    const hooks = writeCheckValuesHooksFile("/agent", history, "change one record", options);
    assert.match(JSON.parse(fs.readFileSync(hooks, "utf8")).hooks[0].before[0], /--guardOptions/);
    assert.equal(JSON.parse(fs.readFileSync(`${history}.guard-options.json`, "utf8")).history, history);
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unavailable or malformed action verdict blocks the write", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-error-"));
  try {
    const fake = path.join(dir, "aux4");
    process.env.AUX4_BIN = fake;
    const options = { configFile: "/local.yaml", packageDir: "/agent" };
    for (const reply of ['not a verdict', '{"allow":"true"}', '{"allow":true}']) {
      fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s' '${reply}'\n`, { mode: 0o755 });
      assert.equal(authorizeAction(options, "records update --id r-1", [{command:"records list",source:"r-1"}]).allow, reply === '{"allow":true}');
    }
    process.env.AUX4_BIN = path.join(dir, "missing");
    assert.equal(authorizeAction(options, "records delete --id r-1").allow, false);
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("existing target IDs require exact observed identifiers, including positional forms", () => {
  const help = "delete\nDelete a record.\n  --recordId <arg>\n    Record identifier.\n  --workspaceId [primary]\n    Workspace identifier.";
  const read = [{ command: "records list", source: '{"id":"r-70"}' }];
  assert.deepEqual(unsourcedActionIds("records delete --recordId r-7", read, "Delete the Winter report", help), [{ parameter: "recordId", value: "r-7" }]);
  assert.equal(unsourcedActionIds("records delete r-7", read, "Delete the Winter report", help).length, 1);
  assert.deepEqual(unsourcedActionIds("records delete r-70 --workspaceId primary", read, "Delete the Winter report", help), []);
  assert.deepEqual(unsourcedActionIds("records delete --recordId r-7", [], "Delete r-7", help), []);
  assert.equal(unsourcedActionIds("records delete --recordId r-7", [{command:"records list --help",source:"r-7"}], "Delete the Winter report", help).length, 1);
  assert.deepEqual(unsourcedActionIds("records create --recordId new-7", [], "Create a report", "create\nCreate a new record."), []);
  assert.deepEqual(unsourcedActionIds("records delete --recordId r-é", [{command:"records list",source:'{"id":"r-\\u00e9"}'}], "Delete the named record", help), []);
});
