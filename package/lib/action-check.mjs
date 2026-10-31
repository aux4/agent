import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isChangeCommand, isReadCommand, runAux4, parseJSONLoose, commandWords, enteredValues, confirmsAction, unsourcedFieldValues, fieldEvidenceText, availableFieldChoices, explicitOpenChoice, observedFieldValue, isConclusiveAttempt, hasPendingWorkflowStage, sameReadEvidence } from "./agent-loop.mjs";
export { actionCheckFiles, actionCheckStats } from "./agent-loop.mjs";

// Read the installed command's contract; do not assume every --to is email
// (other tools can address channels or account IDs).
export function actionCommandHelp(command) {
  if (!isChangeCommand(command) || /(?:^|\s)--help(?:\s|$)/.test(command)) return "";
  const words = commandWords(command) || [];
  if (words[0] === "aux4") words.shift();
  const flag = words.findIndex(word => word.startsWith("--"));
  const commandPath = flag < 0 ? words : words.slice(0, flag);
  if (!commandPath.length) return "";
  const result = runAux4([...commandPath, "--help"], { allowFailure: true, timeout: 5000 });
  return result.ok ? result.stdout.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 6000) : "";
}

const identifierParameter = name => /^(?:id|ids)$/.test(name)
  || /(?:Id|Ids|ID|IDs)$/.test(name) || /[-_]ids?$/i.test(name);
const escapePattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function canonicalCommand(command) {
  const parts = commandWords(command) || [];
  return JSON.stringify(parts[0] === "aux4" ? parts.slice(1) : parts);
}

function formDispatchWords(command) {
  const words = commandWords(command);
  if (!words) return null;
  return words[0] === "aux4" || words[0] === "executeAux4" ? words.slice(1) : words;
}

function optionValue(command, name) {
  const words = commandWords(command) || [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === name) return words[i + 1] || "";
    if (words[i].startsWith(`${name}=`)) return words[i].slice(name.length + 1);
  }
  return "";
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    return url.href;
  } catch { return ""; }
}

function browserRunParts(command) {
  const words = commandWords(command) || [];
  const unprefixed = words[0] === "aux4" ? words.slice(1) : words;
  if (unprefixed[0] !== "agent" || unprefixed[1] !== "browser" || unprefixed[2] !== "run") return null;
  const goal = optionValue(command, "--goal").trim();
  const url = optionValue(command, "--url");
  const session = optionValue(command, "--session");
  const fields = enteredValues(command)
    .filter(entry => !/^confirm$/i.test(entry.label))
    .map(entry => [entry.label.trim().toLowerCase(), entry.value])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  let data = null;
  const rawData = optionValue(command, "--data");
  if (rawData) data = rawData;
  return { goal, resource: normalizedUrl(url), session, fields, data };
}

const OBSERVED_FIELD_ORIGINS = new Set(["explicit-input", "goal-derived", "preexisting", "unknown"]);
const OBSERVED_FIELD_LIMIT = 20;
const OBSERVED_FIELD_VALUE_LIMIT = 1200;

function jsonPointerValue(root, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return { found: false };
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const part = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(part) || Number(part) >= value.length) return { found: false };
      value = value[Number(part)];
    } else if (value && typeof value === "object" && Object.hasOwn(value, part)) {
      value = value[part];
    } else return { found: false };
  }
  return { found: true, value };
}

function fieldIdentity(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldLabelTokens(value) {
  return String(value || "").normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase().match(/[a-z0-9]+/g) || [];
}

function labelAliasMatches(commandLabel, observedLabel) {
  const commandTokens = fieldLabelTokens(commandLabel);
  const observedTokens = new Set(fieldLabelTokens(observedLabel));
  return commandTokens.length > 0 && commandTokens.every(token => observedTokens.has(token));
}

function requestFieldGrammarAnchor(label, value, request) {
  const text = String(request || "");
  const field = fieldIdentity(label);
  const escaped = escapePattern(value);
  if (/(?:^|\b)(?:full)?name\b/.test(field)) {
    return new RegExp(`\\bfor\\s+${escaped}(?=\\s*(?:,|;|$|email\\b|date\\s+of\\s+birth\\b|with\\s+(?:the\\s+)?message\\b))`, "i").test(text);
  }
  if (field === "email" || field.endsWith("email")) return new RegExp(`\\bemail\\s+${escaped}(?=\\s*(?:,|;|$|date\\s+of\\s+birth\\b|with\\s+(?:the\\s+)?message\\b))`, "i").test(text);
  if (field.includes("dateofbirth") || field === "dob") return new RegExp(`\\bdate\\s+of\\s+birth\\s+${escaped}(?=\\s*(?:\\(|,|;|$|with\\s+(?:the\\s+)?message\\b))`, "i").test(text);
  if (field === "message" || field.endsWith("message")) {
    const quoted = new RegExp(`\\bwith\\s+(?:the\\s+)?message\\s+["']${escaped}["']`, "i");
    const plain = new RegExp(`\\bwith\\s+(?:the\\s+)?message\\s+${escaped}(?=\\s*(?:[.!?]|$))`, "i");
    return quoted.test(text) || plain.test(text);
  }
  return false;
}

function fieldLabelBinds(reference, observed, allObserved = []) {
  if (fieldIdentity(reference) === fieldIdentity(observed.label)) return true;
  if (!labelAliasMatches(reference, observed.label)) return false;
  return allObserved.filter(field => labelAliasMatches(reference, field.label)).length === 1;
}

function onlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.has(key));
}

function sourceAttemptByRef(attempts, attemptRef) {
  if (typeof attemptRef !== "string" || !attemptRef) return null;
  return attempts.find(attempt => typeof attempt?.callId === "string" && attempt.callId === attemptRef) || null;
}

function eligibleReadAttempt(attempt) {
  return Boolean(attempt && !attempt.failed && attempt.completed !== false
    && typeof attempt.callId === "string" && attempt.callId
    && isReadCommand(attempt.command || "") && isConclusiveAttempt(attempt));
}

function observedFieldValueText(observed) {
  if (typeof observed.value === "string") return observed.value;
  if (Array.isArray(observed.selectedValues)) return JSON.stringify(observed.selectedValues);
  if (typeof observed.checked === "boolean") return String(observed.checked);
  if (typeof observed.selected === "boolean") return String(observed.selected);
  return null;
}

export function canonicalExplicitDate(request, observed) {
  if (!observed || !["date", "text"].includes(observed.controlType) || typeof observed.value !== "string") return null;
  const label = String(observed.label || "");
  if (!/date/i.test(label) || !/YYYY[-/]MM[-/]DD/i.test(label)) return null;
  const text = String(request || "");
  const dates = [
    ...[...text.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/g)]
      .map(match => ({ day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) })),
    ...[...text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)]
      .map(match => ({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }))
  ]
    .filter(value => {
      if (value.day < 1 || value.month < 1 || value.month > 12 || value.year < 1) return false;
      const parsed = new Date(Date.UTC(value.year, value.month - 1, value.day));
      return parsed.getUTCFullYear() === value.year && parsed.getUTCMonth() === value.month - 1
        && parsed.getUTCDate() === value.day;
    });
  if (dates.length !== 1) return null;
  const date = dates[0];
  const candidate = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  return observed.fieldRef && candidate === observed.value
    ? { fieldRef: observed.fieldRef, requestDate: `${date.day}/${date.month}/${date.year}`, canonicalValue: candidate }
    : null;
}

// A browser model can reject a valid DMY date because it sees the request's
// notation rather than the input's canonical ISO value.  This narrow trusted
// fallback is only available for a complete, current snapshot whose controls
// are all literal/goal-derived values present in the original request and
// whose sole date control has an exact fieldRef/value binding.
export function trustedLiteralDateNormalization(observedFields, request) {
  if (!observedFields || observedFields.status !== "current" || observedFields.formStateComplete !== true
    || observedFields.formStatePartial === true || !Array.isArray(observedFields.fields) || !observedFields.fields.length) return null;
  const fields = observedFields.fields;
  if (fields.some(field => !field || typeof field.fieldRef !== "string" || !field.fieldRef
    || field.status !== "observed" || field.empty === true || !["explicit-input", "goal-derived"].includes(field.origin))) return null;
  const dates = fields.map(field => canonicalExplicitDate(request, field)).filter(Boolean);
  if (dates.length !== 1 || new Set(dates.map(date => date.fieldRef)).size !== 1) return null;
  for (const field of fields) {
    const date = dates[0].fieldRef === field.fieldRef ? dates[0] : null;
    const value = observedFieldValueText(field);
    if (value === null) return null;
    if (!date && (!String(request || "").includes(value) || !String(field.label || "").trim())) return null;
  }
  return dates[0];
}

function evidenceSupportsField(evidence, review, observed, basis, request, attempts, allObserved = []) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  return evidence.every(ref => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
    if (basis === "request") {
      if (!onlyKeys(ref, new Set(["kind", "excerpt", "fieldText", "valueText", "anchor"])) || ref.kind !== "request") return false;
      if (typeof ref.excerpt !== "string" || !ref.excerpt || ref.excerpt.length > 600 || !request.includes(ref.excerpt)
        || typeof ref.fieldText !== "string" || !fieldLabelBinds(ref.fieldText, observed, allObserved)
        || (ref.anchor !== "grammar" && !ref.excerpt.toLowerCase().includes(ref.fieldText.toLowerCase()))) return false;
      if (ref.anchor === "grammar" && !requestFieldGrammarAnchor(ref.fieldText, ref.valueText, request)) return false;
      if (typeof ref.valueText !== "string") return false;
      const direct = ref.valueText === observedFieldValueText(observed) && ref.excerpt.includes(ref.valueText);
      const normalized = canonicalExplicitDate(request, observed);
      const dateParts = normalized && ref.valueText.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
      const explicitDate = normalized && dateParts
        && Number(dateParts[1]) === Number(normalized.requestDate.split("/")[0])
        && Number(dateParts[2]) === Number(normalized.requestDate.split("/")[1])
        && Number(dateParts[3]) === Number(normalized.requestDate.split("/")[2])
        && ref.excerpt.includes(ref.valueText);
      return direct || explicitDate;
    }
    if (basis !== "read" || ref.kind !== "attempt") return false;
    const attempt = sourceAttemptByRef(attempts, ref.attemptRef);
    if (!eligibleReadAttempt(attempt)) return false;
    const source = String(attempt.source ?? attempt.result ?? "");
    if (ref.recordPointer !== undefined || ref.fieldKey !== undefined) {
      if (!onlyKeys(ref, new Set(["kind", "attemptRef", "recordPointer", "fieldKey"]))
        || typeof ref.recordPointer !== "string" || typeof ref.fieldKey !== "string" || !ref.fieldKey.trim()) return false;
      let parsed;
      try { parsed = JSON.parse(source); } catch { return false; }
      const record = jsonPointerValue(parsed, ref.recordPointer);
      if (!record.found || !record.value || typeof record.value !== "object" || Array.isArray(record.value)
        || !Object.hasOwn(record.value, ref.fieldKey)
        || fieldIdentity(ref.fieldKey) !== fieldIdentity(observed.label)) return false;
      const value = record.value[ref.fieldKey];
      return (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        && String(value) === observedFieldValueText(observed);
    }
    if (!onlyKeys(ref, new Set(["kind", "attemptRef", "excerpt", "fieldText", "valueText"]))) return false;
    return typeof ref.excerpt === "string" && ref.excerpt.length > 0 && ref.excerpt.length <= 600
      && source.includes(ref.excerpt)
      && typeof ref.fieldText === "string" && fieldLabelBinds(ref.fieldText, observed, allObserved)
      && ref.excerpt.includes(ref.fieldText)
      && typeof ref.valueText === "string" && ref.valueText === observedFieldValueText(observed)
      && ref.excerpt.includes(ref.valueText);
  });
}

// Deterministic structural gate for a model's semantic assessment. This
// validates the evidence anchors and binding; the semantic mapping from a
// source field to a requested UI control remains an explicit model judgment.
export function validateSubmissionAssessment(assessment, observedFields, request, attempts = []) {
  const deny = reason => ({ allow: false, reason });
  if (!onlyKeys(assessment, new Set(["version", "binding", "fields"]))
    || assessment.version !== 1 || !Array.isArray(assessment.fields)) {
    return deny("A typed submission assessment is required before the form can be submitted.");
  }
  if (!observedFields || observedFields.status !== "current" || observedFields.formStatePartial === true
    || observedFields.formStateComplete !== true
    || !observedFields.session || !observedFields.target || !observedFields.pageUrl || !observedFields.formStateFingerprint) {
    return deny("The current form snapshot is missing, partial, or not bound to a complete target.");
  }
  const binding = assessment.binding;
  if (!onlyKeys(binding, new Set(["session", "target", "pageUrl", "formStateFingerprint"]))
    || binding.session !== observedFields.session || binding.target !== observedFields.target
    || binding.pageUrl !== observedFields.pageUrl || binding.formStateFingerprint !== observedFields.formStateFingerprint) {
    return deny("The submission assessment does not match the pending form, session, page, and fingerprint.");
  }
  const byRef = new Map();
  for (const field of observedFields.fields || []) {
    if (typeof field.fieldRef !== "string" || !field.fieldRef || byRef.has(field.fieldRef)) {
      return deny("The observed form has missing or duplicate control references.");
    }
    byRef.set(field.fieldRef, field);
  }
  if (!byRef.size) return deny("The observed form has no referenced controls to assess.");

  const assessments = new Map();
  const requirements = new Set(["literal-value", "source-value", "preserve-existing", "authorized-default", "unknown"]);
  for (const field of assessment.fields) {
    if (!onlyKeys(field, new Set(["fieldRef", "status", "requirement", "basis", "relation", "evidence"]))
      || typeof field.fieldRef !== "string" || !byRef.has(field.fieldRef) || assessments.has(field.fieldRef)) {
      return deny("The assessment contains a control reference that is missing, duplicated, or outside the current form.");
    }
    if (!requirements.has(field.requirement)) return deny("A form control has no recognized request requirement.");
    assessments.set(field.fieldRef, field);
  }

  for (const [fieldRef, observed] of byRef) {
    // A complete managed snapshot enumerates every value control in the
    // submitted form. Every included control therefore needs an independently
    // grounded assessment; optional/unchanged metadata cannot hide a
    // source-required value or provide an omission escape hatch.
    const needsReview = observedFields.formStateComplete === true
      || observed.required === true || observed.changed === true;
    if (!needsReview) continue;
    const review = assessments.get(fieldRef);
    if (!review) return deny(`Required or changed form control ${observed.label || fieldRef} has no assessment.`);
    if (observed.required === true && observed.empty === true) {
      return deny(`Required form control ${observed.label || fieldRef} is empty.`);
    }
    if (observed.status !== "observed") return deny(`Form control ${observed.label || fieldRef} has no complete observation.`);
    if (review.status !== "verified") return deny(`Form control ${observed.label || fieldRef} is ${review.status === "contradicted" ? "contradicted" : "unknown"}.`);
    if (review.requirement === "unknown") return deny(`The request requirement for form control ${observed.label || fieldRef} is unknown.`);
    // The request-requirement classification itself is model-authored. This
    // path currently has no separate trusted structured user-intent source,
    // so a preserve/default label cannot authorize a required or changed
    // value. Exact request values and successful field-specific reads remain
    // independently checkable below.
    if (review.requirement === "preserve-existing" || review.requirement === "authorized-default") {
      return deny(`Form control ${observed.label || fieldRef} has no independently established preservation or default authorization.`);
    }
    const requirementBasis = {
      "literal-value": new Set(["request", "read"]),
      "source-value": new Set(["read"])
    }[review.requirement];
    if (!requirementBasis?.has(review.basis)) {
      return deny(`The evidence basis does not satisfy the classified request requirement for form control ${observed.label || fieldRef}.`);
    }
    if (review.relation !== "assigns-value") {
      return deny(`Form control ${observed.label || fieldRef} has no recognized field/value relationship.`);
    }
    const redacted = observed.valueRedacted === true || observed.redacted === true;
    const actualValue = observedFieldValueText(observed);
    if (redacted || actualValue === null) {
      return deny(`Form control ${observed.label || fieldRef} has no safely comparable proposed value.`);
    }
    if (review.basis === "request" && review.relation !== "assigns-value") {
      return deny(`Form control ${observed.label || fieldRef} has no request-anchored field/value relationship.`);
    }
    if (review.basis === "read" && review.relation !== "assigns-value") {
      return deny(`Form control ${observed.label || fieldRef} has no read-backed field/value relationship.`);
    }
    if (!evidenceSupportsField(review.evidence, review, observed, review.basis, String(request || ""), attempts, [...byRef.values()])) {
      return deny(`Form control ${observed.label || fieldRef} has no eligible grounded field/value evidence.`);
    }
  }
  return { allow: true, reason: "The required form controls have grounded assessments bound to the current form snapshot." };
}

// Build only the narrow controller-owned assessment that can be established
// without model semantics: every changed/required observed value must be an
// explicit command value (or a goal-derived value), appear in the original
// request, and match the live snapshot. Source-backed or preserved/defaulted
// values intentionally return null and still require the normal assessment.
export function buildTrustedLiteralSubmissionAssessment(command, observedFields, request) {
  if (!observedFields || observedFields.status !== "current" || observedFields.formStateComplete !== true
    || observedFields.formStatePartial === true || !observedFields.session || !observedFields.target
    || !observedFields.pageUrl || !observedFields.formStateFingerprint) return null;
  const supplied = enteredValues(command).filter(entry => !/^confirm$/i.test(entry.label));
  const fields = [];
  const assignments = new Map();
  const usedSupplied = new Set();
  for (const entry of supplied) {
    const exactLabels = (observedFields.fields || []).filter(observed => fieldIdentity(entry.label) === fieldIdentity(observed.label));
    const aliasLabels = (observedFields.fields || []).filter(observed => labelAliasMatches(entry.label, observed.label));
    if (!exactLabels.length && aliasLabels.length > 1) return null;
  }
  for (const observed of observedFields.fields || []) {
    const actual = observedFieldValueText(observed);
    const normalizedDate = canonicalExplicitDate(request, observed);
    const valueMatches = supplied.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
      if (entry.value === actual) return true;
      if (!normalizedDate || normalizedDate.canonicalValue !== actual) return false;
      const parts = String(entry.value).match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
      const requested = normalizedDate.requestDate.split("/");
      return Boolean(parts) && Number(parts[1]) === Number(requested[0])
        && Number(parts[2]) === Number(requested[1]) && Number(parts[3]) === Number(requested[2]);
    });
    const exact = valueMatches.filter(({ entry }) => fieldIdentity(entry.label) === fieldIdentity(observed.label));
    const aliases = valueMatches.filter(({ entry }) => labelAliasMatches(entry.label, observed.label));
    const candidates = exact.length ? exact : aliases;
    if (candidates.length !== 1 || usedSupplied.has(candidates[0].index)) return null;
    usedSupplied.add(candidates[0].index);
    assignments.set(observed, candidates[0].entry);
  }
  for (const observed of observedFields.fields || []) {
    if (!(observedFields.formStateComplete === true || observed.required === true || observed.changed === true)) continue;
    const actual = observedFieldValueText(observed);
    if (typeof observed.fieldRef !== "string" || !observed.fieldRef || actual === null
      || !["explicit-input", "goal-derived"].includes(observed.origin)) return null;
    const normalizedDate = canonicalExplicitDate(request, observed);
    const entry = assignments.get(observed);
    if (!entry) return null;
    const requestText = String(request || "");
    // Keep the exact date spelling from the request for the grammar anchor
    // (canonicalExplicitDate intentionally exposes a normalized D/M/YYYY
    // value for its public contract).  This lets a staged command use
    // 14/03/1990 while the request says 14/03/1990, without weakening the
    // calendar/value binding to the observed ISO control.
    let requestValue = actual;
    if (normalizedDate?.canonicalValue === actual && requestText.includes(normalizedDate.canonicalValue)) {
      requestValue = normalizedDate.canonicalValue;
    } else if (normalizedDate?.canonicalValue === actual) {
      const rawDate = [...requestText.matchAll(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/g)]
        .find(match => Number(match[1]) === Number(normalizedDate.requestDate.split("/")[0])
          && Number(match[2]) === Number(normalizedDate.requestDate.split("/")[1])
          && Number(match[3]) === Number(normalizedDate.requestDate.split("/")[2]));
      requestValue = rawDate?.[0] || normalizedDate.requestDate;
    }
    if (!requestText.includes(requestValue)) return null;
    const valueOffset = requestText.indexOf(requestValue);
    const excerpt = requestText.length <= 600 ? requestText : requestText.slice(Math.max(0, valueOffset - 240), valueOffset + requestValue.length + 240);
    const fieldText = [observed.label, entry.label].map(value => String(value || "").trim()).find(value => value && excerpt.includes(value));
    const anchored = fieldText || requestFieldGrammarAnchor(entry.label, requestValue, request) || requestFieldGrammarAnchor(observed.label, requestValue, request);
    if (!anchored || !excerpt.includes(requestValue)) return null;
    fields.push({
      fieldRef: observed.fieldRef,
      status: "verified",
      requirement: "literal-value",
      basis: "request",
      relation: "assigns-value",
      evidence: [{ kind: "request", excerpt, fieldText: fieldText || observed.label, valueText: requestValue, ...(fieldText ? {} : { anchor: "grammar" }) }]
    });
  }
  if (!fields.length) return null;
  const assessment = {
    version: 1,
    binding: { session: observedFields.session, target: observedFields.target, pageUrl: observedFields.pageUrl, formStateFingerprint: observedFields.formStateFingerprint },
    fields
  };
  return validateSubmissionAssessment(assessment, observedFields, request, [])?.allow === true ? assessment : null;
}

// A pending browser confirmation may carry a live control snapshot. Keep it
// separate from successfulActionsAndResults: the form is evidence of what is
// currently displayed, never independent evidence of where a requested
// value came from.
export function pendingBrowserFieldObservation(command, attempts) {
  if (!confirmsAction(command)) return null;
  const parts = browserRunParts(command);
  if (!parts) return null;
  const commandKey = canonicalCommand(command);
  let pending = null;
  let latestBrowserRun = -1;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (browserRunParts(attempts[i]?.command || "")) { latestBrowserRun = i; break; }
  }
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt.failed || attempt.completed === false) continue;
    const result = parseJSONLoose(String(attempt.source ?? attempt.result ?? ""), null);
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const next = result.confirmation?.next;
    if (typeof next !== "string" || canonicalCommand(next) !== commandKey) continue;
    const status = String(result.status || "").trim().toLowerCase();
    if (i !== latestBrowserRun || !["needs-input", "needs-confirmation"].includes(status) || result.submitted === true) {
      return { status: "mismatched", reason: "The confirmation does not match the latest pending browser operation." };
    }
    if (attempts.slice(i + 1).some(later => !later.failed && later.completed !== false && isChangeCommand(later.command || ""))) {
      return { status: "mismatched", reason: "A later change makes the pending browser form snapshot stale." };
    }
    pending = { attempt, result };
    break;
  }
  if (!pending) return { status: "missing", reason: "No matching pending browser confirmation was found." };

  const { result } = pending;
  const submission = result.formSubmission && typeof result.formSubmission === "object" && !Array.isArray(result.formSubmission)
    ? result.formSubmission : {};
  const pageUrl = String(submission.pageUrl || result.needsInput?.page?.url || result.finalUrl || result.url || "").trim();
  const session = typeof submission.session === "string" ? submission.session.trim()
    : typeof result.session === "string" ? result.session.trim() : "";
  const rawFields = result.preSubmitFieldState;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return {
      status: "unavailable",
      reason: "No form-control snapshot was supplied.",
      ...(session ? { session } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      ...(typeof (submission.target || result.confirmation?.target) === "string" ? { target: String(submission.target || result.confirmation.target).slice(0, 180) } : {}),
      ...(submission.approvalRequired === true ? { approvalRequired: true } : {})
    };
  }
  if (!parts.session || !session || parts.session !== session) {
    return { status: "mismatched", reason: "The pending browser session does not match the confirmation command." };
  }

  const fields = [];
  let redactedFields = 0;
  let truncated = rawFields.length > OBSERVED_FIELD_LIMIT;
  for (const field of rawFields.slice(0, OBSERVED_FIELD_LIMIT)) {
    if (!field || typeof field !== "object" || Array.isArray(field)) { truncated = true; continue; }
    let label = typeof field.label === "string" ? field.label.trim() : "";
    const fieldRef = typeof field.fieldRef === "string" ? field.fieldRef.trim() : "";
    const value = typeof field.value === "string" ? field.value : null;
    const controlType = typeof field.controlType === "string" ? field.controlType.trim().toLowerCase() : "";
    const fieldUrl = typeof field.url === "string" ? field.url.trim() : "";
    let context = typeof field.context === "string" ? field.context.trim() : "";
    if (!label || !fieldUrl || !pageUrl || fieldUrl !== pageUrl) { truncated = true; continue; }
    if (!fieldRef) truncated = true;
    if (field.status !== "observed") truncated = true;
    if (label.length > 160) { label = `${label.slice(0, 160)}…`; truncated = true; }
    if (context.length > 180) { context = `${context.slice(0, 180)}…`; truncated = true; }
    const origin = OBSERVED_FIELD_ORIGINS.has(field.origin) ? field.origin : "unknown";
    const item = {
      label,
      ...(fieldRef ? { fieldRef: fieldRef.slice(0, 180) } : {}),
      controlType: controlType || "unknown",
      ...(context ? { context } : {}),
      origin,
      ...(typeof field.phase === "string" ? { phase: field.phase } : {}),
      ...(typeof field.status === "string" ? { status: field.status } : {}),
      ...(typeof field.changed === "boolean" ? { changed: field.changed } : {}),
      ...(typeof field.required === "boolean" ? { required: field.required } : {})
    };
    if (field.phase !== "before-confirmation") truncated = true;
    const sensitive = field.redacted === true || field.valueRedacted === true || /^(?:password|hidden|file)$/i.test(controlType)
      || /password|one[ -]?time code|secret/i.test(label);
    if (sensitive) {
      item.valueRedacted = true;
      redactedFields++;
      truncated = true;
      fields.push(item);
      continue;
    }
    if (typeof field.checked === "boolean") item.checked = field.checked;
    if (typeof field.empty === "boolean") item.empty = field.empty;
    if (typeof field.selected === "boolean") item.selected = field.selected;
    const selectedValues = Array.isArray(field.selectedValues)
      ? field.selectedValues.slice(0, 20).filter(value => typeof value === "string").map(value => {
        if (value.length > OBSERVED_FIELD_VALUE_LIMIT) {
          truncated = true;
          return `${value.slice(0, OBSERVED_FIELD_VALUE_LIMIT)}…`;
        }
        return value;
      })
      : null;
    if (selectedValues) {
      item.selectedValues = selectedValues;
      if (field.selectedValues.length > 20 || selectedValues.length !== Math.min(field.selectedValues.length, 20)) truncated = true;
    }
    if (value !== null) {
      if (value.length > OBSERVED_FIELD_VALUE_LIMIT) {
        item.value = `${value.slice(0, OBSERVED_FIELD_VALUE_LIMIT)}…`;
        item.valueTruncated = true;
        truncated = true;
      } else item.value = value;
    } else if (!("checked" in item) && !("selected" in item) && !("selectedValues" in item) && !("empty" in item)) {
      truncated = true;
    }
    fields.push(item);
  }
  const contexts = [...new Set(fields.map(field => field.context).filter(Boolean))];
  const target = typeof submission.target === "string" ? submission.target.trim()
    : typeof result.confirmation?.target === "string" ? result.confirmation.target.trim() : "";
  const formStateFingerprint = typeof submission.fingerprint === "string" ? submission.fingerprint.trim()
    : typeof result.confirmation?.formStateFingerprint === "string" ? result.confirmation.formStateFingerprint.trim() : "";
  const formStateComplete = submission.formStateComplete === true || result.confirmation?.formStateComplete === true;
  if (!formStateComplete || submission.partial === true || result.confirmation?.formStatePartial === true) truncated = true;
  if (!pageUrl || contexts.length > 1) {
    return { status: "mismatched", session, ...(pageUrl ? { pageUrl } : {}), reason: "The pending browser field snapshot is missing its page or spans multiple form contexts." };
  }
  if (fields.length === 0) return { status: "unavailable", reason: "No usable form-control snapshot was supplied.", session, pageUrl };
  if (contexts.length !== 1 || fields.some(field => !field.context) || !target || !formStateFingerprint) truncated = true;
  return {
    status: truncated ? "partial" : "current",
    session,
    pageUrl,
    ...(contexts[0] ? { formContext: contexts[0] } : {}),
    ...(target ? { target: target.slice(0, 180) } : {}),
    ...(formStateFingerprint ? { formStateFingerprint: formStateFingerprint.slice(0, 180) } : {}),
    formStateComplete,
    ...(submission.partial === true || result.confirmation?.formStatePartial === true ? { formStatePartial: true } : {}),
    ...(submission.approvalRequired === true ? { approvalRequired: true } : {}),
    fieldCount: rawFields.length,
    ...(redactedFields ? { redactedFields } : {}),
    fields
  };
}

export function createFormApprovalDispatch(command, observedFields) {
  const words = formDispatchWords(command);
  if (!words || words.length < 3 || !observedFields || observedFields.status !== "current"
    || observedFields.formStateComplete !== true
    || observedFields.approvalRequired !== true || !observedFields.session || !observedFields.target
    || !observedFields.pageUrl || !/^[A-Za-z0-9:_-]{1,180}$/.test(observedFields.formStateFingerprint || "")
    || words.some(word => word === "--formStateApproval" || word.startsWith("--formStateApproval="))) return null;
  if (words[0] !== "agent" || words[1] !== "browser" || words[2] !== "run") return null;
  const approvedCommand = `${String(command).trim()} --formStateApproval ${observedFields.formStateFingerprint}`;
  const approvedWords = formDispatchWords(approvedCommand);
  if (!approvedWords) return null;
  return {
    command: approvedCommand,
    binding: {
      session: observedFields.session,
      target: observedFields.target,
      pageUrl: observedFields.pageUrl,
      fingerprint: observedFields.formStateFingerprint,
      dispatchSha256: createHash("sha256").update(JSON.stringify(approvedWords)).digest("hex")
    }
  };
}

export function isTrustedFormApprovalDispatch(command, attempts, binding) {
  const words = formDispatchWords(command);
  const requiredKeys = new Set(["session", "target", "pageUrl", "fingerprint", "dispatchSha256"]);
  if (!onlyKeys(binding, requiredKeys) || !words || !/^[a-f0-9]{64}$/i.test(binding.dispatchSha256)) return false;
  if (createHash("sha256").update(JSON.stringify(words)).digest("hex") !== binding.dispatchSha256) return false;
  const flagIndexes = words.map((word, index) => word === "--formStateApproval" ? index : -1).filter(index => index >= 0);
  if (flagIndexes.length !== 1) return false;
  const flagIndex = flagIndexes[0];
  if (words[flagIndex + 1] !== binding.fingerprint) return false;
  if (words[0] !== "agent" || words[1] !== "browser" || words[2] !== "run") return false;
  const originalWords = [...words.slice(0, flagIndex), ...words.slice(flagIndex + 2)];
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index];
    const result = parseJSONLoose(String(attempt?.source ?? attempt?.result ?? ""), null);
    const next = result?.confirmation?.next;
    if (typeof next !== "string" || JSON.stringify(formDispatchWords(next)) !== JSON.stringify(originalWords)) continue;
    const latestBrowserRun = attempts.reduce((latest, candidate, candidateIndex) =>
      browserRunParts(candidate?.command || "") ? candidateIndex : latest, -1);
    if (index !== latestBrowserRun || attempts.slice(index + 1).some(later =>
      !later.failed && later.completed !== false && isChangeCommand(later.command || ""))) return false;
    const observed = pendingBrowserFieldObservation(next, attempts);
    return observed?.status === "current" && observed.formStateComplete === true && observed.approvalRequired === true
      && observed.session === binding.session && observed.target === binding.target
      && observed.pageUrl === binding.pageUrl && observed.formStateFingerprint === binding.fingerprint;
  }
  return false;
}

function submittedBrowserWorkflows(attempts) {
  const sessions = new Map();
  const sessionOperations = new Map();
  const workflows = [];
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    if (attempt.failed || attempt.completed === false) continue;
    const result = parseJSONLoose(String(attempt.source ?? attempt.result ?? ""), null);
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const attemptParts = browserRunParts(attempt.command);
    const inheritedResource = attemptParts?.resource || sessions.get(attemptParts?.session) || "";
    const observedResource = inheritedResource || normalizedUrl(result.startUrl || result.finalUrl || result.url || "");
    const observedSessions = [attemptParts?.session, result.session].filter(value => typeof value === "string" && value.trim());
    if (observedResource) for (const session of observedSessions) sessions.set(session, observedResource);
    if (!isChangeCommand(attempt.command) || result.submitted !== true
      || !["done", "completed", "success", "succeeded", "incomplete", "needs-input", "needs-confirmation"].includes(String(result.status || "").trim().toLowerCase())) continue;
    const completedParts = attemptParts;
    if (!completedParts) continue;
    const completedCommand = canonicalCommand(attempt.command);
    let origin = null;
    for (let prior = index - 1; prior >= 0; prior--) {
      const candidate = attempts[prior];
      if (candidate.failed) continue;
      const priorResult = parseJSONLoose(String(candidate.source ?? candidate.result ?? ""), null);
      if (!priorResult || typeof priorResult !== "object" || Array.isArray(priorResult)) continue;
      const next = priorResult?.confirmation?.next;
      if (typeof next === "string" && canonicalCommand(next) === completedCommand) {
        origin = candidate;
        break;
      }
    }
    const originParts = origin ? browserRunParts(origin.command) : null;
    const resource = completedParts.resource || originParts?.resource || sessions.get(completedParts.session)
      || normalizedUrl(result.startUrl || result.finalUrl || result.url || "");
    const goal = completedParts.goal || originParts?.goal || String(result.goal || "").trim();
    const fields = completedParts.fields.length ? completedParts.fields : originParts?.fields || [];
    const data = completedParts.data ?? originParts?.data ?? null;
    // A UI target is often a descriptive label (for example a form title) and
    // is not repeated in a later CLI invocation. The exact resource, original
    // goal, and entered non-confirmation values identify the submitted
    // operation; requiring that presentation label in the command misses a
    // restart of the same operation.
    const identity = resource && goal ? { resource, goal, fields, data } : null;
    const operationSessions = [result.session, completedParts.session]
      .filter(value => typeof value === "string" && value.trim());
    if (identity) {
      for (const session of operationSessions) {
        sessions.set(session, identity.resource);
        sessionOperations.set(session, identity);
      }
    }
    workflows.push({ identity });
  }
  return { workflows, sessions, sessionOperations };
}

function submittedWorkflowReplay(command, attempts) {
  const proposed = browserRunParts(command);
  const { workflows, sessions, sessionOperations } = submittedBrowserWorkflows(attempts);
  if (!proposed) return false;
  const resource = proposed.resource || sessions.get(proposed.session) || "";
  if (!resource || !proposed.goal) return false;
  const sessionIdentity = proposed.session && sessionOperations.get(proposed.session);
  const inheritedSessionValues = sessionIdentity?.goal === proposed.goal;
  const fields = proposed.fields.length || !inheritedSessionValues ? proposed.fields : sessionIdentity.fields;
  const data = proposed.data !== null || !inheritedSessionValues ? proposed.data : sessionIdentity.data;
  return workflows.some(workflow => {
    const prior = workflow.identity;
    if (!prior || prior.resource !== resource || prior.goal !== proposed.goal) return false;
    // The goal distinguishes a different requested action; exact field/data
    // equality distinguishes a different operation on the same resource.
    return JSON.stringify(prior.fields) === JSON.stringify(fields)
      && JSON.stringify(prior.data) === JSON.stringify(data);
  });
}

function scopeDenialReason(attempt) {
  const text = String(attempt?.source ?? attempt?.result ?? "");
  const marker = /ACTION_CHECK_SCOPE_DENIED:\s*/i.exec(text);
  if (!marker) return "";
  return text.slice(marker.index + marker[0].length)
    .split(/\s+Check the target and requested scope against the existing facts/i)[0]
    .replace(/\s+/g, " ").trim();
}

// A first denial leaves room for one repair. Repeating the same action and
// denial without any new read facts would spend another authorization call on
// unchanged evidence. Any newly observed successful read permits a fresh
// check; we do not guess whether unfamiliar evidence is relevant to the goal.
function repeatedScopeDenial(command, attempts) {
  const commandKey = canonicalCommand(command);
  const previousIndex = attempts.findLastIndex(attempt => attempt.failed
    && canonicalCommand(attempt.command) === commandKey && scopeDenialReason(attempt));
  if (previousIndex < 0) return null;
  const reason = scopeDenialReason(attempts[previousIndex]);
  const reads = list => list.filter(attempt => attempt.completed !== false && !attempt.failed
    && isReadCommand(attempt.command)
    && !/(?:^|\s)(?:--help|-h)(?:\s|$)/.test(attempt.command || ""));
  const before = reads(attempts.slice(0, previousIndex));
  const after = reads(attempts.slice(previousIndex + 1));
  if (after.length && !sameReadEvidence(after, before)) return null;
  return reason;
}

const COMPLETED_EXECUTION_STATUS = new Set(["done", "completed", "success", "succeeded"]);
const MAX_EXECUTION_STATE_CHARS = 6000;
const MAX_EXECUTION_STATE_COUNT = 12;

// Keep transport/workflow progress separate from factual field evidence. A
// confirmation's `next` command is useful for understanding a pending stage,
// but values or identifiers in that command do not establish a real target.
function executionState(attempt) {
  if (!attempt || attempt.completed === false || attempt.failed) return null;
  const result = parseJSONLoose(attempt.source ?? attempt.result ?? "", null);
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const status = typeof result.status === "string" ? result.status.trim().toLowerCase() : "";
  const needsInputCandidate = result.needsInput && typeof result.needsInput === "object" && !Array.isArray(result.needsInput)
    ? result.needsInput : null;
  const needsInput = needsInputCandidate && (typeof needsInputCandidate.kind === "string" || Number.isInteger(needsInputCandidate.step))
    ? needsInputCandidate : null;
  const confirmationCandidate = result.confirmation && typeof result.confirmation === "object" && !Array.isArray(result.confirmation)
    ? result.confirmation : null;
  const confirmation = confirmationCandidate && typeof confirmationCandidate.next === "string" && confirmationCandidate.next.trim()
    ? confirmationCandidate : null;
  const submitted = typeof result.submitted === "boolean" ? result.submitted : undefined;
  const pending = hasPendingWorkflowStage(result) || (COMPLETED_EXECUTION_STATUS.has(status) && submitted === false);
  const workflowStatus = pending || COMPLETED_EXECUTION_STATUS.has(status);
  if (!workflowStatus) return null;
  const explicitCompletion = !pending && (submitted === true || COMPLETED_EXECUTION_STATUS.has(status));
  return {
    command: String(attempt.command || "").slice(0, 400),
    ...(status ? { status } : {}),
    ...(submitted !== undefined ? { submitted } : {}),
    ...(needsInput ? { needsInput: {
      ...(typeof needsInput.kind === "string" ? { kind: needsInput.kind.slice(0, 80) } : {}),
      ...(Number.isInteger(needsInput.step) ? { step: needsInput.step } : {}),
      ...(typeof needsInput.field?.label === "string" ? { fieldLabel: needsInput.field.label.slice(0, 160) } : {})
    } } : {}),
    ...(confirmation ? { confirmation: {
      ...(typeof confirmation.action === "string" ? { action: confirmation.action.slice(0, 120) } : {}),
      ...(typeof confirmation.target === "string" ? { target: confirmation.target.slice(0, 160) } : {}),
      ...(typeof confirmation.next === "string" ? { next: confirmation.next.slice(0, 500) } : {})
    } } : {}),
    pending,
    explicitCompletion
  };
}

function boundedExecutionStates(attempts) {
  const recent = attempts.map(executionState).filter(Boolean).slice(-MAX_EXECUTION_STATE_COUNT);
  const result = [];
  let remaining = MAX_EXECUTION_STATE_CHARS;
  for (const state of [...recent].reverse()) {
    const size = JSON.stringify(state).length + 1;
    if (size > remaining) continue;
    result.unshift(state);
    remaining -= size;
  }
  return result;
}

export function unsourcedActionIds(command, attempts = [], request = "", reference = "") {
  const words = commandWords(command) || [];
  const flagAt = words.findIndex(word => word.startsWith("--"));
  const prefix = flagAt < 0 ? words : words.slice(0, flagAt);
  const leaf = reference.split(/\r?\n/).find(line => line.trim())?.trim();
  if (/^(?:create|add|insert|new)$/.test(leaf || prefix.at(-1) || "")) return [];
  const targets = [];
  for (let i = 0; i < words.length; i++) {
    const flag = words[i].match(/^--([\w.-]+)(?:=(.*))?$/);
    if (!flag || !identifierParameter(flag[1])) continue;
    const value = flag[2] ?? words[i + 1];
    if (value && !value.startsWith("--")) targets.push({ parameter: flag[1], value });
  }
  // Positional IDs are documented as <arg> parameters by aux4 itself.
  const required = [...reference.matchAll(/^\s+--([\w.-]+)\s+<arg>/gm)].map(match => match[1]);
  const leafAt = leaf ? prefix.lastIndexOf(leaf) : -1;
  if (leafAt >= 0) prefix.slice(leafAt + 1).forEach((value, index) => {
    if (identifierParameter(required[index] || "")) targets.push({ parameter: required[index], value });
  });
  const sources = [request, ...attempts.filter(a => a.completed !== false && !a.failed
    && !/(?:^|\s)--help(?:\s|$)/.test(a.command)).map(a => fieldEvidenceText(a.source ?? a.result ?? "",a.command))].map(String);
  const missing = [];
  for (const target of targets) {
    const defaultValue = reference.match(new RegExp(`^\\s*--${escapePattern(target.parameter)}\\s+\\[([^\\]]+)\\]`, "m"))?.[1];
    for (const value of target.value.split(',').map(value => value.trim()).filter(Boolean)) {
      const exact = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapePattern(value)}(?:$|[^A-Za-z0-9_-])`);
      const observed = sources.some(source => {
        if (exact.test(source)) return true;
        try {
          const queue = [JSON.parse(source)];
          for (let index = 0; index < queue.length; index++) {
            const item = queue[index];
            if (typeof item === "string" && item === value) return true;
            if (item && typeof item === "object") queue.push(...Object.values(item));
          }
        } catch {}
        return false;
      });
      if (value !== defaultValue && !observed) missing.push({ ...target, value });
    }
  }
  return missing;
}

function faithfullyForwardedGoal(words, request, reference) {
  if (!/^\s*--goal\b/m.test(reference)) return false;
  const start=words.findIndex(word=>word.startsWith("--"));
  if(start<0)return false;
  const route=new Map();
  for(let i=start;i<words.length;i++) {
    const flag=words[i].match(/^--(url|goal)(?:=(.*))?$/);
    if(!flag || route.has(flag[1]))return false;
    const value=flag[2] ?? words[++i];
    if(value===undefined || value.startsWith("--"))return false;
    route.set(flag[1],value);
  }
  if(route.get("goal")?.trim()!==request.trim())return false;
  const explicit=[...request.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(match=>match[0].replace(/[),.;!?]+$/,""));
  if(explicit.length) {
    try {if(!route.has("url") || !explicit.some(value=>new URL(value).href===new URL(route.get("url")).href))return false;}catch{return false;}
  }
  return true;
}

export function authorizeAction(options, command, attempts = [], request = "", history = "", commandReference = undefined) {
  const initialWords = commandWords(command) || [];
  const initialPath = initialWords[0] === "aux4" ? initialWords.slice(1) : initialWords;
  if (initialPath[0] === "agent" && initialPath[1] === "browser" && initialPath[2] === "run"
    && initialWords.some(word => word === "--formStateApproval" || word.startsWith("--formStateApproval="))) {
    return { allow: false, reason: "The form-state approval flag is controller-only and cannot be supplied by a model command." };
  }
  if (!isChangeCommand(command) || /(?:^|\s)--help(?:\s|$)/.test(command)) return { allow: true, skipped: true };
  // A delegate may inspect targets the parent has not seen. Still validate
  // the forwarded goal and concrete values against the ORIGINAL request.
  const words = commandWords(command) || [];
  const unprefixed = words[0] === 'aux4' ? words.slice(1) : words;
  const delegatedGoal = (options.delegatedPrefixes || []).some(prefix => {
    const parts = commandWords(prefix) || [];
    return parts.length > 0 && parts.every((part, index) => unprefixed[index] === part);
  });
  const canonical = value => {
    const parts = commandWords(value) || [];
    return JSON.stringify(parts[0] === "aux4" ? parts.slice(1) : parts);
  };
  // The engine already reserves completed writes. Enforce the same invariant
  // before asking a model, while leaving incomplete delegates resumable.
  if (attempts.some(attempt => {
    if (!isConclusiveAttempt(attempt) || canonical(attempt.command) !== canonical(command)) return false;
    const state = executionState(attempt);
    return !state || state.explicitCompletion;
  })) {
    return {allow: false, reason: "This exact change already succeeded. Reuse its result instead of performing it again."};
  }
  if (submittedWorkflowReplay(command, attempts)) {
    return {allow: false, reason: "This browser operation was already submitted for the same resource and operation data. Inspect its result or continue with a distinct requested operation instead of replaying it."};
  }
  const repeatedDenial = repeatedScopeDenial(command, attempts);
  if (repeatedDenial) {
    return {allow: false, repeatedDenial: true, reason: `This exact action was already refused for the same reason: ${repeatedDenial} Obtain new evidence that addresses the refusal or revise the action before retrying.`};
  }
  const confirming = confirmsAction(command);
  const observedFields = pendingBrowserFieldObservation(command, attempts);
  if (observedFields?.status === "mismatched") {
    return { allow: false, reason: "The pending browser form snapshot does not match the confirmation session and form. Re-observe the current form before confirming." };
  }
  const staged = new Map();
  if (delegatedGoal && confirming) for (const attempt of attempts.filter(a => a.completed !== false && !a.failed)) {
    const result = parseJSONLoose(attempt.source ?? attempt.result ?? "", null);
    for (const [label, value] of Object.entries(result?.fromGoal || {})) {
      if (typeof value === "string") staged.set(label, value);
    }
    // Explicit caller data overrides values inferred from a forwarded goal.
    for (const entry of enteredValues(attempt.command)) staged.set(entry.label, entry.value);
  }
  for (const entry of enteredValues(command)) staged.set(entry.label, entry.value);
  const candidateFields = [...staged].map(([label,value])=>({label,value}));
  if (delegatedGoal) {
    const goalAt=words.indexOf("--goal");
    const goal=goalAt>=0 ? words[goalAt+1] || "" : "";
    for (const choice of availableFieldChoices(attempts)) {
      const exact=new RegExp(`(?:^|[^A-Za-z0-9])${escapePattern(choice.value)}(?:$|[^A-Za-z0-9])`,"i");
      if(choice.value && exact.test(goal)) candidateFields.push({label:choice.label || "Required value",value:choice.value});
    }
  }
  // Keep command/result pairs together: a target's membership in a query is
  // evidence, while the target identifier on its own may mean nothing.
  let remaining = 24000;
  const evidence = attempts.filter(a => a.completed !== false && !a.failed && !/(?:^|\s)--help(?:\s|$)/.test(a.command)).map(a => {
    const source = delegatedGoal ? fieldEvidenceText(a.source ?? a.result ?? "",a.command) : String(a.source ?? a.result ?? "");
    const result = source.slice(0, Math.min(4000, remaining));
    remaining -= result.length;
    return { ...(typeof a.callId === "string" && a.callId ? { attemptRef: a.callId } : {}), command: a.command, result, suppliedFields: enteredValues(a.command) };
  });
  const executionStates = boundedExecutionStates(attempts);
  const literalDateNormalizations = (observedFields?.fields || []).map(field => canonicalExplicitDate(request, field)).filter(Boolean);
  const payload = { request, proposedAction: command, delegatedGoal, confirming,
    ...(literalDateNormalizations.length ? { literalDateNormalizations } : {}),
    proposedFields: [...staged].map(([label, value]) => {
      const observed=observedFieldValue(label,attempts);
      return {label,value,...(observed!==null ? {observedValue:observed,unchanged:value===observed} : {})};
    }),
    ...(observedFields ? { observedFields } : {}),
    ...(observedFields?.approvalRequired === true ? { submissionAssessmentRequired: true } : {}),
    explicitlyPermittedChoices: candidateFields.filter(entry=>explicitOpenChoice(entry.label,entry.value,attempts,request)), successfulActionsAndResults: evidence,
    executionStates,
    commandReference: commandReference ?? actionCommandHelp(command) };
  let auditBase = "";
  if (history) {
    fs.mkdirSync(path.dirname(history), { recursive: true });
    auditBase = `${history}.action-check-${randomUUID()}`;
    fs.writeFileSync(`${auditBase}.input.json`, JSON.stringify(payload, null, 2));
  }
  const args = ["ai", "agent", "ask", "--configFile", options.configFile,
    "--instructions", path.join(options.packageDir, "instructions", "loop-authorize.md"),
    "--tools", "currentDateTime", "--policy", '{"budget":{"calls":1}}'];
  if (options.config) args.push("--config", options.config);
  if (auditBase) args.push("--history", `${auditBase}.history.json`);
  args.push("--question", JSON.stringify(payload));
  if(delegatedGoal) {
    const unknownFields=unsourcedFieldValues([...new Set(candidateFields.map(({label,value})=>`${label}=${value}`))],attempts,request);
    if(unknownFields.length){
      const verdict={allow:false,delegated:true,reason: unknownFields.some(entry => entry.directionMismatch) ? "The proposed boolean value reverses an explicit enable/disable instruction. Preserve the requested direction." : unknownFields.some(entry => entry.preserved) ? "The proposed fields change a value the request explicitly says to preserve. Keep its observed value unchanged." : `The value ${unknownFields.map(entry=>entry.label+"="+entry.value).join(", ")} is not established by the request or independent factual evidence. Available options, page labels and staged values do not establish an assigned record value. Look up the actual value or report it missing.`};
      if(auditBase)fs.writeFileSync(`${auditBase}.verdict.json`,JSON.stringify(verdict,null,2));
      return verdict;
    }
  }
  const unknownIds = unsourcedActionIds(command, attempts, request, payload.commandReference);
  if (unknownIds.length) {
    const verdict = { allow: false, reason: `The target identifier ${unknownIds.map(item => item.value).join(", ")} is not established by the request or successful tool evidence. Look up the named target before changing it.` };
    if (auditBase) fs.writeFileSync(`${auditBase}.verdict.json`, JSON.stringify(verdict, null, 2));
    return verdict;
  }
  if (delegatedGoal && !confirming && !candidateFields.length && faithfullyForwardedGoal(unprefixed,request,payload.commandReference)) {
    const verdict={allow:true,delegated:true,forwarded:true,reason:"The original request is forwarded unchanged, without added data or action controls. The registered capability owns inspection and guards its concrete writes."};
    if(auditBase)fs.writeFileSync(`${auditBase}.verdict.json`,JSON.stringify(verdict,null,2));
    return verdict;
  }
  const validDecision = value => value && typeof value.allow === "boolean" && (value.reason === undefined || typeof value.reason === "string");
  let result = runAux4(args, { allowFailure: true, timeout: 45000 });
  let parsed = result.ok ? parseJSONLoose(result.stdout, null) : null;
  let formatRecovery = false;
  // A malformed response is not a decision. Re-evaluate once with the same
  // facts and a corrected response contract; never retry a valid denial.
  if (result.ok && !validDecision(parsed)) {
    const repair = [...args];
    if (auditBase) repair[repair.indexOf("--history") + 1] = `${auditBase}.format-repair.history.json`;
    repair[repair.indexOf("--question") + 1] = JSON.stringify({...payload, responseContract:"The previous response was not valid decision JSON. Re-evaluate the original request and evidence. Return only one valid JSON object: a brief reason first and the final boolean allow last. Do not quote action text or output a reasoning transcript."});
    result = runAux4(repair, {allowFailure:true,timeout:45000});
    parsed = result.ok ? parseJSONLoose(result.stdout,null) : null;
    formatRecovery = true;
  }
  const valid = validDecision(parsed);
  const assessmentRequired = observedFields?.approvalRequired === true;
  const assessmentGate = valid && parsed.allow && assessmentRequired
    ? validateSubmissionAssessment(parsed.submissionAssessment, observedFields, request, attempts)
    : null;
  const assessmentHasSafeShape = !assessmentRequired || !parsed?.submissionAssessment
    || (Array.isArray(parsed.submissionAssessment.fields) && parsed.submissionAssessment.fields.every(field =>
      field && typeof field === "object" && !Object.hasOwn(field, "proposedValue") && !Object.hasOwn(field, "value")));
  const acceptedGate = assessmentGate?.allow === true && assessmentHasSafeShape;
  const acceptedAssessment = assessmentRequired && assessmentGate?.allow === true
    ? {
      version: 1,
      binding: { session: observedFields.session, target: observedFields.target, pageUrl: observedFields.pageUrl, formStateFingerprint: observedFields.formStateFingerprint },
      fields: parsed.submissionAssessment.fields.map(field => ({
        fieldRef: field.fieldRef,
        status: field.status,
        requirement: field.requirement,
        basis: field.basis,
        relation: field.relation,
        evidence: (field.evidence || []).map(ref => ({ kind: ref.kind, ...(ref.attemptRef ? { attemptRef: ref.attemptRef } : {}), ...(ref.recordPointer ? { recordPointer: ref.recordPointer } : {}), ...(ref.fieldKey ? { fieldKey: ref.fieldKey } : {}) }))
      }))
    }
    : null;
  const verdict = {
    allow: Boolean(valid && parsed.allow && (!assessmentRequired || acceptedGate)),
    reason: assessmentRequired && valid && parsed.allow && !acceptedGate
      ? (assessmentGate?.reason || "The submission assessment contains raw field values and was rejected.")
      : valid ? String(parsed.reason || (parsed.allow ? "Authorized by the action check." : "Denied by the action check.")).slice(0,500)
        : "The authorization check did not return a valid decision. This action was not run; more factual lookups cannot repair the check's output format.",
    ...(acceptedGate ? { submissionAssessmentValidated: true } : {}),
    ...(acceptedGate && acceptedAssessment ? { submissionAssessment: acceptedAssessment } : {}),
    ...(formatRecovery ? {formatRecovery:true} : {}),
    ...(!valid ? {protocolError:true} : {})
  };
  if (auditBase) fs.writeFileSync(`${auditBase}.verdict.json`, JSON.stringify(verdict, null, 2));
  return { ...verdict, ...(delegatedGoal ? {delegated: true} : {}) };
}
