import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { authorizeAction } from "../lib/action-check.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function captureAuthorization({ request, proposedAction, attempts, commandReference }, assertCapture) {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-contract-"));
  const captureFile = path.join(dir, "capture.json");
  const fake = path.join(dir, "aux4");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const question = JSON.parse(args[args.indexOf('--question') + 1]);
const instructions = fs.readFileSync(args[args.indexOf('--instructions') + 1], 'utf8');
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ question, instructions }));
const history = args.indexOf('--history');
if (history >= 0) fs.writeFileSync(args[history + 1], JSON.stringify({ messages: [], tokenUsage: {} }));
console.log(JSON.stringify({ allow: false, reason: 'Stub response; semantic decision is not under test.' }));
`, { mode: 0o755 });
  process.env.AUX4_BIN = fake;
  try {
    authorizeAction({ configFile: "/test/config.yaml", config: "test", packageDir: PACKAGE_DIR },
      proposedAction, attempts, request, path.join(dir, "run.json"), commandReference);
    assertCapture(JSON.parse(fs.readFileSync(captureFile, "utf8")));
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN;
    else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("authorization contract permits an evidenced member step without treating it as completion", () => {
  const request = "Update the selected records, leaving the protected record unchanged.";
  const proposedAction = "records update --id record-a --status archived";
  const attempts = [{
    command: "records list --query selected",
    source: JSON.stringify({ records: [
      { id: "record-a", selected: true },
      { id: "record-b", selected: true },
      { id: "record-x", selected: false, protected: true }
    ] }),
    completed: true,
    failed: false
  }];

  captureAuthorization({ request, proposedAction, attempts, commandReference: "update\nUpdate a record's status.\n  --id <arg>" },
    ({ question, instructions }) => {
      assert.equal(question.request, request);
      assert.equal(question.proposedAction, proposedAction);
      assert.match(question.successfulActionsAndResults[0].result, /record-a/);
      assert.match(instructions, /a plural request\s+describes the requested set/);
      assert.match(instructions, /establishes that exact target as eligible/);
      assert.match(instructions, /Do not deny solely\s+because other eligible targets remain/);
      assert.match(instructions, /not a verdict that the whole request is complete/);
    });
});

test("authorization contract keeps resource and effect matching as independent gates", () => {
  const request = "Update the selected records' status.";
  const proposedAction = "records create --name " + "replacement";
  const attempts = [{
    command: "records list --query selected",
    source: '{"records":[{"id":"record-a","selected":true}]}',
    completed: true,
    failed: false
  }];

  captureAuthorization({ request, proposedAction, attempts, commandReference: "create\nCreate a new record." },
    ({ question, instructions }) => {
      assert.equal(question.proposedAction, proposedAction);
      assert.match(question.commandReference, /Create a new record/);
      assert.match(instructions, /actual resource and effect/);
      assert.match(instructions, /does not match any\s+requested step, deny it/);
    });
});

test("authorization contract preserves exclusions for commands affecting one or many targets", () => {
  const request = "Update eligible records, but do not change the protected record.";
  const proposedAction = "records update --id record-a --id record-x --status archived";
  const attempts = [{
    command: "records list",
    source: '{"records":[{"id":"record-a","eligible":true},{"id":"record-x","eligible":false,"protected":true}]}',
    completed: true,
    failed: false
  }];

  captureAuthorization({ request, proposedAction, attempts, commandReference: "update\nUpdate one or more records." },
    ({ question, instructions }) => {
      assert.match(question.request, /do not change the protected record/);
      assert.match(question.proposedAction, /record-x/);
      assert.match(question.successfulActionsAndResults[0].result, /protected/);
      assert.match(instructions, /every affected\s+target must be established as eligible/);
      assert.match(instructions, /no excluded or unrequested target\s+may be included/);
      assert.match(instructions, /An explicitly\s+excluded target must be left alone/);
    });
});
