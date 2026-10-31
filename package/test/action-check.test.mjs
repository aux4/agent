import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { authorizeAction, actionCheckFiles, actionCheckStats, createFormApprovalDispatch, isTrustedFormApprovalDispatch, unsourcedActionIds, validateSubmissionAssessment } from "../lib/action-check.mjs";
import { fieldEvidenceText, isConclusiveAttempt, unsourcedFieldValues, writeCheckValuesHooksFile } from "../lib/agent-loop.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fieldEvidenceAssessment({ request, fieldRef = "field-priority", label = "Priority", value = "Urgent", basis = "request", attemptRef = "", fieldKey = "", status = "verified" } = {}) {
  const excerpt = basis === "authorized-default" ? "selected default Priority" : basis === "preserve-existing" ? "Leave Priority unchanged" : "Priority is Urgent";
  const evidence = basis === "read"
    ? [{ kind: "attempt", attemptRef, recordPointer: "/record", fieldKey }]
    : [{ kind: "request", excerpt, fieldText: label, ...(basis === "authorized-default" || basis === "preserve-existing" ? {} : { valueText: value }) }];
  return {
    version: 1,
    binding: { session: "session-1", target: "target-1", pageUrl: "https://example.test/form", formStateFingerprint: "sha256:form-1" },
    fields: [{ fieldRef, status, basis, relation: basis === "authorized-default" ? "authorizes-default" : basis === "preserve-existing" ? "preserves-value" : "assigns-value", evidence }]
  };
}

function observedFormField(overrides = {}) {
  return {
    status: "current", session: "session-1", target: "target-1", pageUrl: "https://example.test/form",
    formStateFingerprint: "sha256:form-1", formStatePartial: false,
    fields: [{ fieldRef: "field-priority", label: "Priority", value: "Urgent", origin: "goal-derived", changed: true, required: true, empty: false, status: "observed" }],
    ...overrides
  };
}

test("typed form assessment verifies an exact request anchor against the bound observed control", () => {
  const request = "Priority is Urgent.";
  const assessment = fieldEvidenceAssessment({ request });
  assert.deepEqual(validateSubmissionAssessment(assessment, observedFormField(), request), {
    allow: true,
    reason: "The required form controls have grounded assessments bound to the current form snapshot."
  });
});

test("typed form assessment rejects missing, stale, partial, or contradictory state", () => {
  const request = "Priority is Urgent.";
  const valid = fieldEvidenceAssessment({ request });
  assert.equal(validateSubmissionAssessment(null, observedFormField(), request).allow, false);
  assert.equal(validateSubmissionAssessment(valid, observedFormField({ formStateFingerprint: "sha256:other" }), request).allow, false);
  assert.equal(validateSubmissionAssessment(valid, observedFormField({ status: "partial" }), request).allow, false);
  assert.equal(validateSubmissionAssessment(fieldEvidenceAssessment({ request, status: "contradicted" }), observedFormField(), request).allow, false);
  assert.equal(validateSubmissionAssessment(fieldEvidenceAssessment({ request, status: "unknown" }), observedFormField(), request).allow, false);
});

test("required and changed controls cannot be omitted or left empty", () => {
  const request = "Priority is Urgent.";
  const valid = fieldEvidenceAssessment({ request });
  assert.equal(validateSubmissionAssessment({ ...valid, fields: [] }, observedFormField(), request).allow, false);
  assert.equal(validateSubmissionAssessment(valid, observedFormField({ fields: [{ ...observedFormField().fields[0], empty: true, value: "" }] }), request).allow, false);
});

test("source evidence must bind the destination field as well as its exact value", () => {
  const request = "Set Priority after looking up the record.";
  const attempts = [{
    callId: "read-1", command: "records get --id rec-1", completed: true, failed: false,
    source: JSON.stringify({ record: { priority: "Urgent", issue: "Urgent" } })
  }];
  const valid = fieldEvidenceAssessment({ request: "Priority is Urgent.", basis: "read", attemptRef: "read-1", fieldKey: "priority" });
  assert.equal(validateSubmissionAssessment(valid, observedFormField(), request, attempts).allow, true);
  const wrongField = fieldEvidenceAssessment({ request: "Priority is Urgent.", basis: "read", attemptRef: "read-1", fieldKey: "issue" });
  assert.equal(validateSubmissionAssessment(wrongField, observedFormField(), request, attempts).allow, false,
    "a matching value under a different source field cannot substantiate this control");
  const failedRead = [{ ...attempts[0], failed: true }];
  assert.equal(validateSubmissionAssessment(valid, observedFormField(), request, failedRead).allow, false);
});

test("authorized defaults and unrelated unchanged preexisting controls retain distinct evidence paths", () => {
  const defaultRequest = "Use the selected default Priority.";
  const defaultAssessment = fieldEvidenceAssessment({ request: defaultRequest, value: "Urgent", basis: "authorized-default" });
  assert.equal(validateSubmissionAssessment(defaultAssessment, observedFormField({ fields: [{
    ...observedFormField().fields[0], origin: "preexisting", changed: false
  }] }), defaultRequest).allow, true);

  const preserveRequest = "Continue without changing unrelated fields.";
  const preserved = observedFormField({ fields: [{
    ...observedFormField().fields[0], origin: "preexisting", changed: false, required: true
  }] });
  const preserveAssessment = {
    ...fieldEvidenceAssessment({ request: "Leave Priority unchanged.", value: "Urgent", basis: "preserve-existing" }),
    fields: [{ ...fieldEvidenceAssessment({ request: "Leave Priority unchanged.", value: "Urgent", basis: "preserve-existing" }).fields[0], evidence: [] }]
  };
  assert.equal(validateSubmissionAssessment(preserveAssessment, preserved, preserveRequest).allow, true);
  const namedRequest = "Leave Priority unchanged.";
  const namedPreserve = fieldEvidenceAssessment({ request: namedRequest, value: "Urgent", basis: "preserve-existing" });
  assert.equal(validateSubmissionAssessment(namedPreserve, preserved, namedRequest).allow, true);
  assert.equal(validateSubmissionAssessment({ ...namedPreserve, fields: [{ ...namedPreserve.fields[0], evidence: [] }] }, preserved, namedRequest).allow, false,
    "an explicitly named field cannot be dismissed as unrelated without a preserve instruction");
});

test("action check requires a complete assessment for a root-managed pending form commit", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-form-approval-"));
  try {
    const fake = path.join(dir, "aux4");
    const capture = path.join(dir, "capture.json");
    const request = "Set Priority to Urgent.";
    const command = "agent browser run --session session-1 --field confirm=yes";
    const snapshot = {
      status: "needs-confirmation", submitted: false, session: "session-1", finalUrl: "https://example.test/form",
      confirmation: { action: "Submit", next: command, formStateFingerprint: "sha256:form-1" },
      formSubmission: { session: "session-1", target: "target-1", pageUrl: "https://example.test/form", fingerprint: "sha256:form-1", partial: false, approvalRequired: true },
      preSubmitFieldState: [{
        fieldRef: "field-priority", url: "https://example.test/form", label: "Priority", context: "form Intake",
        controlType: "text", value: "Urgent", origin: "goal-derived", changed: true, required: true,
        empty: false, status: "observed", phase: "before-confirmation"
      }],
      needsInput: { kind: "confirm", page: { url: "https://example.test/form" } }
    };
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const payload=JSON.parse(args[args.indexOf('--question')+1]);
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(payload));
const field=payload.observedFields.fields[0];
const assessment={version:1,binding:{session:payload.observedFields.session,target:payload.observedFields.target,pageUrl:payload.observedFields.pageUrl,formStateFingerprint:payload.observedFields.formStateFingerprint},fields:[{fieldRef:field.fieldRef,status:'verified',basis:'request',relation:'assigns-value',evidence:[{kind:'request',excerpt:'Priority to Urgent',fieldText:'Priority',valueText:'Urgent'}]}]};
console.log(JSON.stringify({allow:true,reason:'The requested field value is grounded.',submissionAssessment:assessment}));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const result = authorizeAction({ configFile: "/config/local.yaml", packageDir: PACKAGE_DIR, delegatedPrefixes: ["agent browser"] }, command, [
      { command: "agent browser run --url https://example.test/form --goal 'Set Priority to Urgent.'", source: JSON.stringify(snapshot), completed: true, failed: false, callId: "pending-call" }
    ], request, "", "run\n  --goal <arg>");
    assert.equal(result.allow, true, result.reason);
    assert.equal(result.submissionAssessmentValidated, true);
    assert.equal(result.submissionAssessment.binding.formStateFingerprint, "sha256:form-1");
    assert.equal(result.submissionAssessment.fields[0].fieldRef, "field-priority");
    assert.equal(Object.hasOwn(result.submissionAssessment.fields[0], "proposedValue"), false);
    const payload = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(payload.submissionAssessmentRequired, true);
    assert.equal(payload.observedFields.approvalRequired, true);
    assert.equal(payload.successfulActionsAndResults[0].attemptRef, "pending-call");
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("model-provided approval flags are rejected before the existing action check", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-forged-form-approval-"));
  try {
    const log = path.join(dir, "called");
    const fake = path.join(dir, "aux4");
    fs.writeFileSync(fake, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(log)},'called');
console.log(JSON.stringify({allow:true,reason:'not relevant'}));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const result = authorizeAction({ configFile: "/config/local.yaml", packageDir: PACKAGE_DIR },
      "agent browser run --url https://example.test/form --formStateApproval sha256:forged", [], "Submit the form.");
    assert.equal(result.allow, false);
    assert.match(result.reason, /approval flag is controller-only/);
    assert.equal(fs.existsSync(log), false);
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("controller approval dispatch binds one exact pending form continuation and snapshot", () => {
  const observed = observedFormField({ approvalRequired: true });
  const pendingCommand = "agent browser run --session session-1 --field confirm=yes";
  const attempt = {
    callId: "pending-call", command: "agent browser run --url https://example.test/form --goal 'Set Priority to Urgent.'",
    completed: true, failed: false,
    source: JSON.stringify({
      status: "needs-confirmation", submitted: false, session: observed.session,
      confirmation: { next: pendingCommand, target: observed.target, formStateFingerprint: observed.formStateFingerprint },
      formSubmission: {
        session: observed.session, target: observed.target, pageUrl: observed.pageUrl,
        fingerprint: observed.formStateFingerprint, partial: false, approvalRequired: true
      },
      needsInput: { kind: "confirm", page: { url: observed.pageUrl } },
      preSubmitFieldState: [{
        fieldRef: observed.fields[0].fieldRef, url: observed.pageUrl, label: observed.fields[0].label,
        value: observed.fields[0].value, context: "form Intake", controlType: "text",
        origin: "goal-derived", changed: true, required: true, empty: false,
        status: "observed", phase: "before-confirmation"
      }]
    })
  };
  const dispatch = createFormApprovalDispatch(pendingCommand, observed);
  assert.ok(dispatch);
  assert.match(dispatch.command, /--formStateApproval sha256:form-1$/);
  assert.equal(isTrustedFormApprovalDispatch(dispatch.command, [attempt], dispatch.binding), true);
  assert.equal(isTrustedFormApprovalDispatch(`${dispatch.command} --extra yes`, [attempt], dispatch.binding), false);
  assert.equal(isTrustedFormApprovalDispatch(dispatch.command, [{ ...attempt, source: attempt.source.replace('"pageUrl":"https://example.test/form"', '"pageUrl":"https://other.test"') }], dispatch.binding), false);
  assert.equal(createFormApprovalDispatch(`${pendingCommand} --formStateApproval sha256:forged`, observed), null);
});

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

test("authorization payload preserves the requested operation and command effect for the existing check", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-effect-contract-"));
  try {
    const fake = path.join(dir, "aux4");
    const capture = path.join(dir, "capture.json");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const question=JSON.parse(args[args.indexOf('--question')+1]);
const instructions=fs.readFileSync(args[args.indexOf('--instructions')+1],'utf8');
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,question,instructions}));
console.log(JSON.stringify({allow:false,reason:'The proposed effect is not the requested operation.'}));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const options = { configFile: "/local.yaml", packageDir: PACKAGE_DIR };
    const request = "Send a message to Morgan with the verified inspection time.";
    const command = "records create --owner morgan@work.test --start 2026-04-01T14:00:00Z";
    const reference = "create\nCreate a record.\n\n  --owner <arg>\n    Owner email address.\n";
    const denied = authorizeAction(options, command, [
      { command: "inspection get", source: "The inspection is at 14:00 UTC.", completed: true, failed: false }
    ], request, "", reference);
    assert.equal(denied.allow, false);
    const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(captured.question.request, request);
    assert.equal(captured.question.proposedAction, command);
    assert.match(captured.question.commandReference, /Create a record/);
    assert.match(captured.instructions, /actual resource and effect/i);
    assert.match(captured.instructions, /different operation equivalent/i);
    assert.match(captured.instructions, /request to complete a form\s+or workflow may include its normal save or submit step/i);
    assert.match(captured.instructions, /fill-only, draft-only, or do-not-submit limit/i);
    assert.equal(captured.args.filter(value => value === "--question").length, 1,
      "the existing authorization call is reused; no second model call is introduced");
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pending browser field state is carried separately from independent source evidence", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-observed-fields-"));
  try {
    const fake = path.join(dir, "aux4");
    const capture = path.join(dir, "capture.json");
    const calls = path.join(dir, "calls.txt");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
const payload=JSON.parse(args[args.indexOf('--question')+1]);
const instructions=fs.readFileSync(args[args.indexOf('--instructions')+1], 'utf8');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({payload,instructions}));
console.log(JSON.stringify({allow:true,reason:'The pending form state was reviewed.'}));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const url = "https://records.example.test/form/new";
    const request = "Complete the requested form for Morgan with issue An unexpected charge appeared, and use the selected default Category.";
    const command = `aux4 agent browser run --session 's-1' --goal '${request}' --field 'confirm=yes'`;
    const pending = {
      status: "needs-input",
      submitted: false,
      session: "s-1",
      finalUrl: url,
      confirmation: { action: "Submit", target: "Submit — form \"Intake\"", next: command, formStateFingerprint: "sha256:pending-form-1", formStatePartial: true },
      needsInput: { kind: "confirm", page: { url } },
      preSubmitFieldState: [
        { url, label: "Record name", value: "Morgan", context: 'form "Intake"', controlType: "text", phase: "before-confirmation", status: "observed", origin: "explicit-input", changed: true },
        { url, label: "Issue", value: "An unexpected charge appeared.", context: 'form "Intake"', controlType: "textarea", phase: "before-confirmation", status: "observed", origin: "explicit-input" },
        { url, label: "Category", value: "Billing", context: 'form "Intake"', controlType: "text", phase: "before-confirmation", status: "observed", origin: "preexisting", changed: false, required: false },
        { url, label: "Email updates", context: 'form "Intake"', controlType: "checkbox", phase: "before-confirmation", status: "observed", origin: "preexisting", checked: false, changed: false, required: false },
        { url, label: "Credential", value: "must-not-leak", selectedValues: ["Sensitive choice"], context: 'form "Intake"', controlType: "text", phase: "before-confirmation", status: "observed", origin: "unknown", redacted: true }
      ],
      observations: { current: "The form is ready." }
    };
    const options = { configFile: "/config/local.yaml", packageDir: PACKAGE_DIR, delegatedPrefixes: ["agent browser"] };
    const result = authorizeAction(options, command, [
      { command: "agent browser find --url https://records.example.test/form/new --question 'What category is assigned to this record?'", source: JSON.stringify({ answered: true, matches: [{ text: "The assigned category is Billing." }] }), completed: true, failed: false },
      { command: `agent browser run --url https://records.example.test/form/new --goal '${request}' --field 'Record name=Morgan' --field 'Issue=An unexpected charge appeared.'`, source: JSON.stringify(pending), completed: true, failed: false }
    ], request, "", "run\nComplete a page form.");
    assert.equal(result.allow, true);
    const { payload, instructions } = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepEqual(payload.observedFields, {
      status: "partial", session: "s-1", pageUrl: url, formContext: 'form "Intake"',
      target: 'Submit — form "Intake"',
      formStateFingerprint: "sha256:pending-form-1", formStatePartial: true, fieldCount: 5, redactedFields: 1,
      fields: [
        { label: "Record name", value: "Morgan", controlType: "text", context: 'form "Intake"', origin: "explicit-input", phase: "before-confirmation", status: "observed", changed: true },
        { label: "Issue", value: "An unexpected charge appeared.", controlType: "textarea", context: 'form "Intake"', origin: "explicit-input", phase: "before-confirmation", status: "observed" },
        { label: "Category", value: "Billing", controlType: "text", context: 'form "Intake"', origin: "preexisting", phase: "before-confirmation", status: "observed", changed: false, required: false },
        { label: "Email updates", controlType: "checkbox", context: 'form "Intake"', origin: "preexisting", phase: "before-confirmation", status: "observed", changed: false, required: false, checked: false },
        { label: "Credential", controlType: "text", context: 'form "Intake"', origin: "unknown", phase: "before-confirmation", status: "observed", valueRedacted: true }
      ]
    });
    const sources = JSON.stringify(payload.successfulActionsAndResults.map(entry => entry.result));
    assert.doesNotMatch(sources, /An unexpected charge appeared\./);
    assert.doesNotMatch(JSON.stringify(payload.observedFields), /must-not-leak|Sensitive choice/);
    assert.match(sources, /assigned category is Billing/i, "field-specific read evidence stays in the source channel");
    assert.match(sources, /pageUrl/);
    assert.ok(payload.successfulActionsAndResults.some(entry => entry.suppliedFields.some(field => field.label === "Issue" && field.value === "An unexpected charge appeared.")), "prior command values are visible only as suppliedFields, not independent read evidence");
    assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1, "the existing authorization call is reused");
    assert.match(instructions, /field and value/);
    assert.match(instructions, /not an\s+independent source/);
    assert.match(instructions, /explicitly\s+authorizes using or preserving that default/);
    assert.match(instructions, /Do not require new provenance for unrelated preexisting fields/);
    assert.match(instructions, /successful read\s+that binds the value to that field first/);
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a pending browser snapshot with mismatched session, form, or fingerprint is rejected before authorization", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-observed-fields-mismatch-"));
  try {
    const fake = path.join(dir, "aux4");
    fs.writeFileSync(fake, "#!/bin/sh\nprintf 'called' >> \"$CALL_LOG\"\nprintf '%s' '{\"allow\":true}'\n", { mode: 0o755 });
    const calls = path.join(dir, "calls.txt");
    process.env.AUX4_BIN = fake;
    process.env.CALL_LOG = calls;
    const url = "https://records.example.test/form/new";
    const command = "agent browser run --session new-session --goal 'Complete the requested form' --field confirm=yes";
    for (const mismatch of ["session", "form"]) {
      const pending = {
        status: "needs-input", submitted: false, session: mismatch === "session" ? "old-session" : "new-session", finalUrl: url,
        confirmation: {
          action: "Submit", target: "Submit — form Intake", next: command,
          formStateFingerprint: "sha256:old-form"
        },
        needsInput: { kind: "confirm", page: { url } },
        preSubmitFieldState: [
          { url, label: "Record name", value: "Morgan", context: "form Intake", controlType: "text", status: "observed", phase: "before-confirmation" },
          ...(mismatch === "form" ? [{ url, label: "Other value", value: "x", context: "form Other", controlType: "text", status: "observed", phase: "before-confirmation" }] : [])
        ]
      };
      const result = authorizeAction(
        { configFile: "/config/local.yaml", packageDir: PACKAGE_DIR, delegatedPrefixes: ["agent browser"] },
        command,
        [{ command: "agent browser run --url https://records.example.test/form/new --goal 'Complete the requested form'", source: JSON.stringify(pending), completed: true, failed: false }],
        "Complete the requested form", "", "run\nComplete a page form."
      );
      assert.equal(result.allow, false, `${mismatch} mismatch must block`);
      assert.match(result.reason, /does not match the confirmation session and form/);
    }
    assert.equal(fs.existsSync(calls), false, "mismatched snapshot must block before invoking authorization");
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    delete process.env.CALL_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unbound partial snapshot is passed to the existing authorization check", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-partial-form-snapshot-"));
  try {
    const fake = path.join(dir, "aux4");
    const capture = path.join(dir, "capture.json");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const payload=JSON.parse(args[args.indexOf('--question')+1]);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(payload));
console.log(JSON.stringify({allow:true,reason:'The requested non-source-dependent continuation is supported.'}));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const url = "https://records.example.test/form/new";
    const command = "agent browser run --session s-1 --goal 'Continue the requested workflow' --field confirm=yes";
    const pending = {
      status: "needs-input", submitted: false, session: "s-1", finalUrl: url,
      confirmation: { action: "Continue", target: "Continue — form Details", next: command },
      needsInput: { kind: "confirm", page: { url } },
      preSubmitFieldState: [{ url, label: "Record name", value: "Morgan", context: "form Details", controlType: "text", status: "observed", phase: "before-confirmation" }]
    };
    const result = authorizeAction(
      { configFile: "/config/local.yaml", packageDir: PACKAGE_DIR, delegatedPrefixes: ["agent browser"] },
      command,
      [{ command: "agent browser run --url https://records.example.test/form/new --goal 'Continue the requested workflow'", source: JSON.stringify(pending), completed: true, failed: false }],
      "Continue the requested workflow", "", "run\nContinue the observed workflow."
    );
    assert.equal(result.allow, true);
    const payload = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(payload.observedFields.status, "partial");
    assert.equal(payload.observedFields.formContext, "form Details");
    assert.equal(Object.hasOwn(payload.observedFields, "formStateFingerprint"), false);
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-browser confirmations do not require browser field snapshots", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-nonbrowser-confirm-"));
  try {
    const fake = path.join(dir, "aux4");
    const capture = path.join(dir, "capture.json");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const payload=JSON.parse(args[args.indexOf('--question')+1]);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(payload));
console.log(JSON.stringify({allow:true,reason:'The requested update is authorized.'}));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const command = "records update --field 'confirm=yes'";
    const result = authorizeAction(
      { configFile: "/config/local.yaml", packageDir: PACKAGE_DIR },
      command,
      [{ command: "records update --field 'name=Alpha'", source: JSON.stringify({
        status: "needs-input", confirmation: { action: "Save", target: "Save record", next: command }
      }), completed: true, failed: false }],
      "Save the requested record", "", "update\nUpdate a record."
    );
    assert.equal(result.allow, true);
    const payload = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(Object.hasOwn(payload, "observedFields"), false);
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent browser form snapshot is passed as unavailable instead of blocking unrelated confirmations", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-check-no-form-snapshot-"));
  try {
    const fake = path.join(dir, "aux4");
    const capture = path.join(dir, "capture.json");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, args[args.indexOf('--question')+1]);
console.log(JSON.stringify({allow:true,reason:'No field value depends on a missing form snapshot.'}));
`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const url = "https://records.example.test/confirm";
    const command = "agent browser run --session s-1 --goal 'Continue the requested workflow' --field confirm=yes";
    const pending = {
      status: "needs-input", submitted: false, session: "s-1", finalUrl: url,
      confirmation: { action: "Continue", target: "Continue workflow", next: command },
      needsInput: { kind: "confirm", page: { url } },
      preSubmitFieldState: []
    };
    const result = authorizeAction(
      { configFile: "/config/local.yaml", packageDir: PACKAGE_DIR, delegatedPrefixes: ["agent browser"] },
      command,
      [{ command: "agent browser run --url https://records.example.test/start --goal 'Continue the requested workflow'", source: JSON.stringify(pending), completed: true, failed: false }],
      "Continue the requested workflow", "", "run\nContinue the observed workflow."
    );
    assert.equal(result.allow, true);
    const payload = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(payload.observedFields.status, "unavailable");
    assert.equal(payload.observedFields.session, "s-1");
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
      denial,
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

test("authorization keeps multi-step execution state separate from facts and only rejects explicit completion", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-state-authorization-"));
  const fake = path.join(dir, "aux4"), payloadLog = path.join(dir, "payloads.jsonl"), modelCalls = path.join(dir, "model-calls");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);const payload=JSON.parse(args[args.indexOf('--question')+1]);
fs.appendFileSync(${JSON.stringify(payloadLog)},JSON.stringify(payload)+'\\n');
const count=fs.existsSync(${JSON.stringify(modelCalls)})?Number(fs.readFileSync(${JSON.stringify(modelCalls)},'utf8')):0;
fs.writeFileSync(${JSON.stringify(modelCalls)},String(count+1));
console.log(JSON.stringify({allow:true,reason:'The requested continuation is supported.'}));
`, { mode: 0o755 });
  process.env.AUX4_BIN = fake;
  try {
    const options = { configFile: "/local.yaml", packageDir: "/agent", delegatedPrefixes: ["agent records"] };
    const command = 'agent records run --url https://example.test/records --goal "Finalize the selected record" --field "confirm=yes"';
    const request = "Finalize the selected record after its required confirmations.";
    const pending = step => ({
      status: "needs-input", submitted: false,
      needsInput: { kind: "confirm", step, field: { label: `Confirm ${step}` } },
      confirmation: {
        action: `Confirm ${step}`, target: `Record stage ${step}`,
        next: `${command} --field 'Record Code=ghost-${step}'`
      },
      pageUrl: "https://example.test/records/selected"
    });
    const attempts = [{ command, source: JSON.stringify(pending(1)), completed: true, failed: false }];
    let sideEffects = 0;
    const authorizeContinuation = () => {
      const verdict = authorizeAction(options, command, attempts, request, "", "run\n  --goal <arg>\n  --field <value>");
      if (verdict.allow) sideEffects++;
      return verdict;
    };

    assert.equal(isConclusiveAttempt(attempts[0]), false, "a structured confirmation is pending, not completed");
    assert.equal(isConclusiveAttempt({ source: '{"status":"done","submitted":true,"confirmation":{"id":"receipt-1"}}' }), true,
      "a terminal receipt may include a business confirmation object without becoming pending");
    assert.deepEqual(JSON.parse(fieldEvidenceText('{"status":"pending","id":"record-17","confirmation":{"id":"receipt-17"}}')),
      { status: "pending", id: "record-17", confirmation: { id: "receipt-17" } },
      "business pending/confirmation fields remain factual when they lack the recognized workflow contract");
    assert.equal(isConclusiveAttempt({ source: '{"status":"deleted","id":"record-17"}' }), true,
      "business completion status remains conclusive");
    assert.equal(authorizeContinuation().allow, true, "the first pending stage remains resumable");
    attempts.push({ command, source: JSON.stringify(pending(2)), completed: true, failed: false });
    assert.equal(authorizeContinuation().allow, true, "the same command can continue from a distinct pending stage");

    const payloads = fs.readFileSync(payloadLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[0].executionStates.map(state => [state.status, state.needsInput.step, state.pending, state.explicitCompletion]), [
      ["needs-input", 1, true, false]
    ]);
    assert.deepEqual(payloads[1].executionStates.map(state => [state.status, state.needsInput.step, state.pending, state.explicitCompletion]), [
      ["needs-input", 1, true, false], ["needs-input", 2, true, false]
    ]);
    assert.ok(JSON.stringify(payloads[1].executionStates).length <= 6000);
    assert.match(payloads[1].executionStates[1].confirmation.next, /ghost-2/);
    assert.doesNotMatch(JSON.stringify(payloads[1].successfulActionsAndResults), /ghost-|needs-input|confirmation|Record stage/,
      "continuation commands and pending protocol details do not become value/target evidence");

    const done = { command, source: JSON.stringify({ status: "done", submitted: true }), completed: true, failed: false };
    attempts.push(done);
    assert.equal(isConclusiveAttempt(done), true);
    const duplicate = authorizeContinuation();
    assert.equal(duplicate.allow, false);
    assert.match(duplicate.reason, /already succeeded/);
    assert.equal(Number(fs.readFileSync(modelCalls, "utf8")), 2, "completed duplicates are denied before another model authorization");
    assert.equal(sideEffects, 2, "the simulated operation is reached only after each allow verdict");

    const pendingAttempt = { command, source: JSON.stringify(pending(1)), completed: true, failed: false };
    const unknownTarget = unsourcedActionIds("records delete --recordId ghost-47", [{
      ...pendingAttempt, source: JSON.stringify({ ...pending(1), confirmation: { next: "records delete --recordId ghost-47" } })
    }], "Delete the selected record", "delete\n  --recordId <arg>");
    assert.deepEqual(unknownTarget.map(item => item.value), ["ghost-47"], "a next command cannot establish its target ID");
    const targetDenied = authorizeAction({ ...options, delegatedPrefixes: [] }, "records delete --recordId ghost-47", [{
      ...pendingAttempt, source: JSON.stringify({ ...pending(1), confirmation: { next: "records delete --recordId ghost-47" } })
    }], "Delete the selected record", "", "delete\n  --recordId <arg>");
    assert.equal(targetDenied.allow, false);
    assert.match(targetDenied.reason, /not established/);
    assert.equal(Number(fs.readFileSync(modelCalls, "utf8")), 2, "next-command IDs cannot bypass the deterministic target check");

    const unknownFieldCommand = 'agent records run --url https://example.test/records --goal "Finalize the selected record" --field "Record Code=ghost-1"';
    const fieldDenied = authorizeAction(options, unknownFieldCommand, [pendingAttempt], request, "", "run\n  --goal <arg>\n  --field <value>");
    assert.equal(fieldDenied.allow, false);
    assert.match(fieldDenied.reason, /not established/);
    assert.equal(Number(fs.readFileSync(modelCalls, "utf8")), 2, "next-command fields cannot bypass value provenance");
    assert.deepEqual(unsourcedFieldValues(["Record Code=ghost-1"], [{
      ...pendingAttempt
    }], "Finalize the selected record"), [{ label: "Record Code", value: "ghost-1" }],
    "a value echoed only in a continuation command remains unsourced");
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a submitted browser workflow is bound to its resource and operation across transient sessions", () => {
  const original = process.env.AUX4_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "submitted-browser-replay-"));
  try {
    const fake = path.join(dir, "aux4");
    fs.writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({allow:true,reason:'A distinct requested operation is allowed.'}));\n`, { mode: 0o755 });
    process.env.AUX4_BIN = fake;
    const options = { configFile: "/local.yaml", packageDir: PACKAGE_DIR };
    const origin = "agent browser run --url 'https://example.test/records/#/record/R-11' --goal 'Save record R-11' --field 'Reference=R-11'";
    const next = "agent browser run --session s-before --goal 'Save record R-11' --field 'confirm=yes'";
    const submitted = "agent browser run --session s-before --goal \"Save record R-11\" --field \"confirm=yes\"";
    const attempts = [
      { command: origin, completed: true, failed: false, source: JSON.stringify({ status: "needs-input", confirmation: {
        action: "Save record", target: "Save — form \"Record details\"", emptyFields: [], next
      } }) },
      { command: submitted, completed: true, failed: false, source: JSON.stringify({
        status: "incomplete", submitted: true, session: "s-after", finalUrl: "https://example.test/records/#/record/R-11"
      }) }
    ];
    const sameOperationNewSession = "agent browser run --session s-after --goal 'Save record R-11' --field 'confirm=yes'";
    const blocked = authorizeAction(options, sameOperationNewSession, attempts, "Save record R-11.");
    assert.equal(blocked.allow, false);
    assert.match(blocked.reason, /already submitted/);
    assert.equal(authorizeAction(options, submitted, attempts, "Save record R-11.").allow, false,
      "replaying the exact session confirmation does not require restating fields from the originating step");
    const sameSessionChangedField = "agent browser run --session s-after --goal 'Save record R-11' --field 'Reference=R-12' --field 'confirm=yes'";
    assert.equal(authorizeAction(options, sameSessionChangedField, attempts, "Save record R-11.").allow, true,
      "explicit changed values on a known session override inherited prior values");

    const sameResourceFreshSession = "agent browser run --url 'https://example.test/records/#/record/R-11' --session s-unrelated --goal 'Save record R-11' --field 'Reference=R-11' --field \"confirm=yes\"";
    assert.equal(authorizeAction(options, sameResourceFreshSession, attempts, "Save record R-11.").allow, false,
      "a fresh transient session does not make the same resource and operation new");

    const sameResourceNewInputs = "agent browser run --url 'https://example.test/records/#/record/R-11' --goal 'Save record R-11' --field 'Reference=R-11' --field 'comment=updated' --field 'confirm=yes'";
    assert.equal(authorizeAction(options, sameResourceNewInputs, attempts, "Save record R-11.").allow, true,
      "a materially changed field value is not classified as a replay; normal authorization still decides it");

    const differentAction = "agent browser run --url 'https://example.test/records/#/record/R-11' --goal 'Delete record R-11' --field 'Reference=R-11' --field 'confirm=yes'";
    assert.equal(authorizeAction(options, differentAction, attempts, "Save record R-11.").allow, true,
      "a different operation goal is not classified as a replay; this mock allow is not user-authority evidence");

    const changedDomAttempts = [...attempts, {
      command: "agent browser inspect --session s-after", completed: true, failed: false,
      source: JSON.stringify({ status: "ok", session: "s-after", url: "https://example.test/records/#/record/R-11",
        controls: [{ role: "button", label: "Save updated record" }] })
    }];
    assert.equal(authorizeAction(options, sameResourceFreshSession, changedDomAttempts, "Save record R-11.").allow, false,
      "later DOM descriptors do not reclassify a submitted operation as new");

    const pendingOnly = [{ command: origin, completed: true, failed: false, source: JSON.stringify({ status: "needs-input", confirmation: {
      action: "Save record", target: "Save — form \"Record details\"", emptyFields: [], next
    } }) }];
    const pendingContinuation = authorizeAction(options, submitted, pendingOnly, "Save record R-11.");
    assert.equal(pendingContinuation.allow, true, "the first confirmation continuation remains allowed before submission");

    const differentFragment = "agent browser run --url 'https://example.test/records/#/record/R-12' --session s-new --goal 'Save record R-11' --field 'Reference=R-11' --field 'confirm=yes'";
    const distinct = authorizeAction(options, differentFragment, attempts, "Save record R-11.");
    assert.equal(distinct.allow, true, "the same goal and fields on a different fragment resource is a distinct operation");
    const oldSessionDifferentResource = "agent browser run --url 'https://example.test/records/#/record/R-12' --session s-after --goal 'Save record R-11' --field 'Reference=R-11' --field 'confirm=yes'";
    assert.equal(authorizeAction(options, oldSessionDifferentResource, attempts, "Save record R-11.").allow, true,
      "an old session cannot override an explicitly different resource");

    const dataOrigin = "agent browser run --url 'https://example.test/records/#/record/R-11' --goal 'Save record R-11' --data '{\"a\":1,\"b\":2}'";
    const dataNext = "agent browser run --session data-before --goal 'Save record R-11' --field 'confirm=yes'";
    const dataAttempts = [
      { command: dataOrigin, completed: true, failed: false, source: JSON.stringify({ status: "needs-input", confirmation: {
        action: "Save record", target: "Save — form \"Record details\"", emptyFields: [], next: dataNext
      } }) },
      { command: dataNext, completed: true, failed: false, source: JSON.stringify({ status: "incomplete", submitted: true,
        session: "data-after", finalUrl: "https://example.test/records/#/record/R-11" }) }
    ];
    const sameData = "agent browser run --url 'https://example.test/records/#/record/R-11' --goal 'Save record R-11' --data '{\"a\":1,\"b\":2}'";
    assert.equal(authorizeAction(options, sameData, dataAttempts, "Save record R-11.").allow, false,
      "the exact submitted data remains part of replay identity");
    const largeDataOrigin = "agent browser run --url 'https://example.test/records/#/record/R-11' --goal 'Save record R-11' --data '{\"id\":9007199254740992}'";
    const largeDataNext = "agent browser run --session large-before --goal 'Save record R-11' --field 'confirm=yes'";
    const largeDataAttempts = [
      { command: largeDataOrigin, completed: true, failed: false, source: JSON.stringify({ status: "needs-input", confirmation: {
        action: "Save record", target: "Save — form \"Record details\"", emptyFields: [], next: largeDataNext
      } }) },
      { command: largeDataNext, completed: true, failed: false, source: JSON.stringify({ status: "incomplete", submitted: true,
        session: "large-after", finalUrl: "https://example.test/records/#/record/R-11" }) }
    ];
    const distinctLargeId = "agent browser run --url 'https://example.test/records/#/record/R-11' --goal 'Save record R-11' --data '{\"id\":9007199254740993}'";
    assert.equal(authorizeAction(options, distinctLargeId, largeDataAttempts, "Save record R-11.").allow, true,
      "different data values remain a distinct operation without lossy JSON normalization");
  } finally {
    if (original === undefined) delete process.env.AUX4_BIN; else process.env.AUX4_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
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
