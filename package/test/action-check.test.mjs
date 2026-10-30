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


test("delegated goals and staged fields are checked against the original request",()=>{
  const original=process.env.AUX4_BIN;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delegated-scope-'));
  const bin=path.join(dir,'aux4'),log=path.join(dir,'payload.json');
  fs.writeFileSync(bin,`#!/usr/bin/env node
const fs=require('fs');const args=process.argv.slice(2);const payload=JSON.parse(args[args.indexOf('--question')+1]);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(payload));console.log(JSON.stringify({allow:false,reason:'An available option is not an assigned value.'}));`,{mode:0o755});
  process.env.AUX4_BIN=bin;
  try{
    const options={configFile:'/local.yaml',packageDir:'/agent',delegatedPrefixes:['agent forms']};
    const request='Submit the application using its assigned category.';
    const prior=[{command:'records get',source:'{"Category":"Gold","Region":"West"}'},{command:'agent forms run --field "Category=Gold"',source:'{"status":"needs-input","fromGoal":{"Region":"West"}}'}];
    const result=authorizeAction(options,'agent forms run --session s7 --field confirm=yes',prior,request,'','run\n --field <value>');
    assert.equal(result.allow,false);assert.equal(result.delegated,true);assert.notEqual(result.skipped,true);
    const payload=JSON.parse(fs.readFileSync(log,'utf8'));assert.equal(payload.delegatedGoal,true);assert.equal(payload.confirming,true);
    assert.deepEqual(payload.proposedFields.sort((a,b)=>a.label.localeCompare(b.label)),[{label:'Category',value:'Gold',observedValue:'Gold',unchanged:true},{label:'Region',value:'West',observedValue:'West',unchanged:true}]);
    assert.equal(payload.request,request);
  }finally{if(original===undefined)delete process.env.AUX4_BIN;else process.env.AUX4_BIN=original;fs.rmSync(dir,{recursive:true,force:true});}
});

test("ranked page evidence reaches delegated authorization as positive facts but cannot authorize a field", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ranked-evidence-auth-"));
  const fake = path.join(dir, "aux4"), count = path.join(dir, "count"), payloadFile = path.join(dir, "payload.json");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);const payload=JSON.parse(args[args.indexOf('--question')+1]);
fs.writeFileSync(${JSON.stringify(count)},String((fs.existsSync(${JSON.stringify(count)})?Number(fs.readFileSync(${JSON.stringify(count)})):0)+1));
fs.writeFileSync(${JSON.stringify(payloadFile)},JSON.stringify(payload));
console.log(JSON.stringify({allow:false,reason:'The page does not expose an editable Record ID field.'}));
`, { mode: 0o755 });
  process.env.AUX4_BIN = fake;
  try {
    const options = { configFile: "/local.yaml", packageDir: "/agent", delegatedPrefixes: ["agent forms"] };
    const command = 'agent forms run --url https://example.test/records --goal "Archive the selected record" --field "Record ID=rec-17"';
    const request = "Archive the selected record that is named on the page.";
    const reference = "run\n  --goal <arg>\n  --field <value>";
    const valid = {
      answered: true, question: "find the selected record", url: "https://example.test/records", matches: [],
      pageEvidence: {
        coverage: "ranked-top-k", complete: false, limitPerPage: 2,
        pages: [{ page: 3, url: "https://example.test/records?page=3", matches: [{
          text: "rec-17 | Rowan Lee | selected", block: { id: "row-17" },
          location: { url: "https://example.test/records?page=3", selector: "#row-17" }
        }] }]
      }
    };
    const attempts = [{ tool: "executeAux4", command: "agent browser find --url https://example.test/records --question selected", source: JSON.stringify(valid), completed: true, failed: false }];
    const denied = authorizeAction(options, command, attempts, request, "", reference);
    assert.equal(denied.allow, false, "evidence of an ID does not establish that the command exposes an editable field or authorize the action");
    const payload = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
    assert.match(payload.successfulActionsAndResults[0].result, /rec-17 \| Rowan Lee \| selected/);
    assert.match(payload.successfulActionsAndResults[0].result, /ranked-top-k/);
    assert.equal(payload.successfulActionsAndResults[0].result.includes('"complete":false'), true);
    assert.match(payload.successfulActionsAndResults[0].result, /sourceUrl/);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 1);

    const invalid = { ...valid, pageEvidence: { coverage: "ranked-top-k", complete: true, limitPerPage: 2, pages: valid.pageEvidence.pages } };
    const invalidResult = authorizeAction(options, command, [{ ...attempts[0], source: JSON.stringify(invalid) }], request, "", reference);
    assert.equal(invalidResult.allow, false);
    assert.match(invalidResult.reason, /Record ID=rec-17/);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 1, "invalid/incomplete metadata must not reach the authorization model as positive evidence");
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated scope denials stop on unchanged reads and recheck after any new successful read", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-denial-recovery-"));
  const fake = path.join(dir, "aux4"), count = path.join(dir, "count");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const previous=fs.existsSync(${JSON.stringify(count)})?Number(fs.readFileSync(${JSON.stringify(count)},'utf8')):0;
fs.writeFileSync(${JSON.stringify(count)},String(previous+1));
console.log(JSON.stringify({allow:false,reason:'The requested action target is outside the available scope.'}));
`, { mode: 0o755 });
  process.env.AUX4_BIN = fake;
  try {
    const options = { configFile: "/local.yaml", packageDir: "/agent" };
    const command = "records archive --recordId rec-17";
    const reference = "archive\n  --recordId <arg>";
    const request = "Archive the selected record.";
    const initialRead = { command: "records get --id rec-17", source: '{"id":"rec-17","name":"Rowan Lee","status":"selected"}', completed: true, failed: false };
    const first = authorizeAction(options, command, [initialRead], request, "", reference);
    assert.equal(first.allow, false);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 1, "the first authorization check is allowed to make a reasoned denial");

    const denial = { command, source: "Blocked by hook: ACTION_CHECK_SCOPE_DENIED: The requested action target is outside the available scope.", completed: true, failed: true };
    const suppressed = authorizeAction(options, command, [initialRead, denial], request, "", reference);
    assert.equal(suppressed.allow, false);
    assert.equal(suppressed.repeatedDenial, true);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 1, "no new evidence does not repeat the identical check");

    const duplicateRead = authorizeAction(options, command, [initialRead, denial, { ...initialRead }], request, "", reference);
    assert.equal(duplicateRead.repeatedDenial, true);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 1, "a normalized duplicate read is not new evidence");

    const schemaRead = { command: "records fields describe", source: '{"fields":[{"label":"Status","type":"select"}]}', completed: true, failed: false };
    const freshRead = authorizeAction(options, command, [initialRead, denial, schemaRead], request, "", reference);
    assert.equal(freshRead.allow, false, "unfamiliar new evidence permits a fresh decision without being treated as authorization");
    assert.equal(freshRead.repeatedDenial, undefined);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 2);

    const newMatchingRead = { ...initialRead, command: "records get --id rec-17 --details", source: '{"id":"rec-17","name":"Rowan Lee","status":"selected","details":"freshly read"}' };
    const retried = authorizeAction(options, command, [initialRead, denial, schemaRead, newMatchingRead], request, "", reference);
    assert.equal(retried.allow, false, "new evidence permits a fresh authorization decision but does not grant permission");
    assert.equal(retried.repeatedDenial, undefined);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 3);

    const secondDenial = { ...denial };
    const sameAgain = authorizeAction(options, command, [initialRead, denial, schemaRead, newMatchingRead, secondDenial], request, "", reference);
    assert.equal(sameAgain.repeatedDenial, true);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 3, "the same denial is bounded again after an evidence-triggered recheck");

    const revised = authorizeAction(options, "records archive --recordId rec-18", [
      initialRead,
      { command: "records get --id rec-18", source: '{"id":"rec-18","status":"selected"}', completed: true, failed: false }
    ], request, "", reference);
    assert.equal(revised.allow, false);
    assert.equal(Number(fs.readFileSync(count, "utf8")), 4, "a revised explicit target receives its own authorization check");
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("a forwarded goal echo cannot establish an existing resource identifier",()=>{
  const fake=[{command:'agent browser run --goal "Show report-17"',source:'{"status":"done","goal":"Show report-17","observations":{"current":"Report index"}}'}];
  assert.equal(unsourcedActionIds('reports delete --id report-17',fake,'Delete the Winter report','delete').length,1);
});


test("completed exact writes are rejected before model judgment; incomplete writes stay resumable", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duplicate-write-"));
  const fake = path.join(dir, "aux4");
  fs.writeFileSync(fake, `#!/bin/sh
printf '%s' '{"allow":true,"reason":"Allowed"}'
`, {mode:0o755});
  process.env.AUX4_BIN = fake;
  try {
    const command = "records archive --id r-7";
    const options = {configFile: "/local.yaml", packageDir: "/agent"};
    const completed = [{command, completed:true, source:'{"archived":true}'}];
    assert.match(authorizeAction(options, "aux4 " + command, completed, "Archive r-7").reason, /already succeeded/);
    for (const source of ['{"status":"needs-input"}', '{"status":"pending","submitted":false}']) {
      assert.equal(authorizeAction(options, command, [{command, source}], "Archive r-7", "", "archive").allow, true);
    }
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, {recursive:true, force:true});
  }
});


test("malformed guard replies get one bounded re-evaluation and valid denials are never retried", () => {
  const original=process.env.AUX4_BIN;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"guard-format-"));
  const fake=path.join(dir,"aux4"),counter=path.join(dir,"counter");
  const options={configFile:"/local.yaml",packageDir:"/agent"};
  try {
    process.env.AUX4_BIN=fake;
    for (const replies of [
      ['{broken','{"reason":"authorized target","allow":true}'],
      ['{"reason":"excluded target","allow":false}'],
      ['{"allow":"true"}']
    ]) {
      fs.rmSync(counter,{force:true});
      fs.writeFileSync(fake,`#!/usr/bin/env node
const fs=require('fs');const file=${JSON.stringify(counter)};const n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(n+1));const replies=${JSON.stringify(replies)};console.log(replies[Math.min(n,replies.length-1)]);
`,{mode:0o755});
      const verdict=authorizeAction(options,"records update --id r7",[],"Update r7",path.join(dir,"run"),"update");
      assert.equal(verdict.allow,replies.length===2);
      assert.equal(Number(fs.readFileSync(counter)),replies[0].includes('excluded')?1:2);
      if(replies.length===2)assert.equal(verdict.formatRecovery,true);
      if(replies[0]==='{"allow":"true"}')assert.equal(verdict.protocolError,true);
    }
  } finally {if(original===undefined)delete process.env.AUX4_BIN;else process.env.AUX4_BIN=original;fs.rmSync(dir,{recursive:true,force:true});}
});


test("an unchanged registered goal may inspect, while added fields, flags and substituted URLs still need verification", () => {
  const original=process.env.AUX4_BIN;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"faithful-goal-"));
  const fake=path.join(dir,"aux4");
  fs.writeFileSync(fake,`#!/bin/sh
printf '%s' '{"allow":false,"reason":"needs normal verification"}'
`,{mode:0o755});
  process.env.AUX4_BIN=fake;
  try {
    const options={configFile:"/local.yaml",packageDir:"/agent",delegatedPrefixes:["agent forms"]};
    const request="Submit the application at https://example.test/apply for Morgan using the assigned category.";
    const command='agent forms run --url https://example.test/apply --goal "'+request+'"';
    const help="run\n  --goal <arg>";
    assert.equal(authorizeAction(options,command,[],request,"",help).forwarded,true);
    assert.equal(authorizeAction(options,command+' --field "Name=Morgan"',[],request,"",help).allow,false);
    assert.equal(authorizeAction(options,command+' --playbook anything',[],request,"",help).allow,false);
    assert.equal(authorizeAction(options,command.replace('--url https://example.test/apply','--url https://example.test/other'),[],request,"",help).allow,false);
  } finally {if(original===undefined)delete process.env.AUX4_BIN;else process.env.AUX4_BIN=original;fs.rmSync(dir,{recursive:true,force:true});}
});
