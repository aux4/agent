#!/usr/bin/env node
import fs from "node:fs";
import { authorizeAction, actionCommandHelp } from "./action-check.mjs";
// `aux4 agent check-values` -- a `before` hook target for aux4/ai-agent's
// tool-call hooks (HARN-030). Wired in agent-loop.mjs's checkValuesHooksFile
// as command guards and a `before` hook on every `agent:browser/run` call:
// invented recipients and out-of-scope changes are stopped before execution,
// and a confirmation re-checks everything typed before it.
//
// Checks the PENDING call's own --field values (passed as --fieldsJson, the
// hook's ${field} context var -- a JSON array when the call repeated --field,
// or a plain string when it didn't) against everything that happened before
// it in this round: the original request plus every earlier tool result.
// Exits non-zero (blocking the call -- see aux4/ai-agent's `before` phase)
// and prints the same message the two-round confirmation gate would have
// asked for, when any value cannot be found anywhere. Exits 0 silently
// otherwise, letting the confirmation run.
import { extractAttemptLog, unsourcedFieldValues, unsourcedRecipientValues, composeNotConfirmedQuestion, enteredValues, dataEntries, pendingConfirmation, hasConfirmationContract, namesUnselectedItem, isReadCommand, isChangeCommand, sameReadEvidence, commandWords, runAux4 } from "./agent-loop.mjs";

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[token.slice(2)] = "";
    } else {
      options[token.slice(2)] = next;
      i++;
    }
  }
  return options;
}

export function parseFields(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [raw];
  }
}

function contextAttempts(history, historyFiles="") {
  const paths=historyFiles ? JSON.parse(historyFiles) : [];
  if(!Array.isArray(paths) || paths.some(value=>typeof value!=="string"))throw new Error("Invalid source history context");
  const attempts=new Map();
  let serial=0;
  for(const file of [...new Set([...paths,history].filter(Boolean))]) for(const attempt of extractAttemptLog(file))attempts.set(attempt.callId || `unidentified-${serial++}`,attempt);
  return [...attempts.values()];
}

export function checkValues({ request = "", history = "", fieldsJson = "", dataJson = "", historyFiles = "" } = {}) {
  // --data JSON values are checked exactly like --field values.
  const dataFields = dataEntries(dataJson).map(e => `${e.label}=${e.value}`);
  const dataConfirms = (() => {
    try {
      const v = JSON.parse(dataJson || "");
      return Boolean(v && typeof v === "object" && Object.entries(v).some(([k, x]) => /^confirm$/i.test(k) && (x === true || /^yes$/i.test(String(x)))));
    } catch { return false; }
  })();
  const fields = [...parseFields(fieldsJson), ...dataFields, ...(dataConfirms ? ["confirm=yes"] : [])];
  const attempts = contextAttempts(history,historyFiles);
  // Confirming commits everything entered so far, not just this call's own
  // values: check every value an earlier browser call typed in, too.
  const confirming = fields.some(f => /^\s*confirm\s*=\s*(yes|true)\s*$/i.test(String(f)));
  const earlier = confirming
    ? attempts.filter(a => !a.failed && /\bagent browser run\b/.test(a.command || ""))
        .flatMap(a => enteredValues(a.command).map(e => `${e.label}=${e.value}`))
    : [];
  if (confirming && !confirmationWasAsked(attempts)) return [{ label: "confirm", value: "yes", notAsked: true }];
  // When the action waiting for this confirmation names one specific item the request
  // does not pick out, ask the person which one (a form's own submit is not blocked).
  if (confirming) {
    const pending = lastPendingConfirmation(attempts);
    if (pending && pending.label && namesUnselectedItem(pending.target || pending.label, request)) {
      return [{ label: "confirm", value: "yes", unclear: true, action: pending.label }];
    }
    // The form still has empty fields: fill them from the request, or ask -- never
    // confirm an incomplete submission.
    if (pending && pending.emptyFields && pending.emptyFields.length) {
      return [{ label: "confirm", value: "yes", emptyFields: pending.emptyFields, action: pending.label }];
    }
  }
  return unsourcedFieldValues([...new Set([...fields, ...earlier])], attempts, request);
}

// A short-model tool loop can poll or repeat the same lookup many times in a
// single execution turn, before the outer plan/verify loop gets a chance to
// stop it. After two successful reads return the same facts, block the next
// equivalent read until a state-changing command succeeds. The agent can choose a
// different source, use a real polling interval, or report the remaining gap.
export function repeatedReadGuardMessage(command, attempts = []) {
  const requested = String(command || "").trim();
  if (!requested || !isReadCommand(requested)) return "";
  const words = commandWords(requested);
  if (words.includes("--help") || words.includes("-h")) return "";
  let lastChange = -1;
  attempts.forEach((attempt, index) => {
    if (attempt.completed !== false && !attempt.failed && isChangeCommand(attempt.command || "")) lastChange = index;
  });
  const reads = attempts.slice(lastChange + 1).filter(attempt =>
    attempt.tool === "executeAux4" && attempt.completed !== false && !attempt.failed
      && isReadCommand(attempt.command)
      && JSON.stringify(commandWords(attempt.command)) === JSON.stringify(words)
  );
  if (reads.length < 2 || !sameReadEvidence([reads.at(-1)], reads.slice(0, -1))) return "";
  return "Error: recent lookups already returned the same evidence twice. Do not repeat another equivalent search or status check; use a materially different source/scope, wait with a polling interval if this is a running job, or report what remains unknown.";
}

// The most recent tool result still waiting for a confirmation, if any.
function lastPendingConfirmation(attempts) {
  for (let i = attempts.length; i > 0; i--) {
    const p = pendingConfirmation(attempts.slice(0, i));
    if (p) return p;
  }
  return null;
}

// A confirmation only answers a tool that emitted the structured contract
// this round; display text is not used to infer whether one was asked.
export function confirmationWasAsked(attempts) {
  return attempts.some(a => {
    if (a.failed) return false;
    return hasConfirmationContract(a.source ?? a.result ?? "");
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  options.historyFiles = options.historyFiles || process.env.AUX4_AGENT_HISTORY_FILES || "";
  // The person's original request, when the harness wrote it next to the history.
  if (options.requestFile) {
    try { options.request = fs.readFileSync(options.requestFile, "utf8"); } catch { if(options.fieldsStdin)process.exit(1); }
  }
  if (options.fieldsStdin) {
    let input;
    try { input=JSON.parse(fs.readFileSync(0,"utf8")); } catch { process.exit(1); }
    if (!input || !Array.isArray(input.fields) || !input.fields.length || input.fields.some(entry=>!entry || typeof entry.label!=="string" || typeof entry.value!=="string")) process.exit(1);
    const available=input.availableChoices || {};
    if (typeof available!=="object" || Array.isArray(available) || Object.values(available).some(values=>!Array.isArray(values) || values.some(value=>typeof value!=="string"))) process.exit(1);
    const attempts=contextAttempts(options.history,options.historyFiles);
    attempts.push({command:"native field choices",source:JSON.stringify({options:available})});
    const missing=unsourcedFieldValues(input.fields,attempts,options.request);
    if(missing.length){process.stdout.write("A field value needs the original request or an independent factual lookup.\n");process.exit(1);}
    process.exit(0);
  }
  if (options.repeatReadGuard) {
    const attempts = contextAttempts(options.history,options.historyFiles);
    const reference = actionCommandHelp(options.command);
    const recipients = unsourcedRecipientValues(options.command, attempts, options.request, reference);
    const words = commandWords(options.command) || [];
    const flagIndex = words.findIndex(word => word.startsWith("--"));
    const actionPath = (flagIndex < 0 ? words : words.slice(0, flagIndex)).filter((word, i) => i !== 0 || word !== "aux4");
    const leaf = reference.split(/\r?\n/).find(line => line.trim())?.trim();
    const leafAt = leaf ? actionPath.lastIndexOf(leaf) : -1;
    const parentPath = leafAt > 0 ? actionPath.slice(0, leafAt) : actionPath.slice(0, -1);
    const parentHelp = [...parentPath, "--help"].join(" ");
    const lookupHelp = recipients.length
      ? runAux4([...parentPath, "--help"], { allowFailure: true, timeout: 5000 }) : null;
    const lookupReference = lookupHelp?.ok && !/^(?:Command not found|Error executing command)/m.test(lookupHelp.stdout)
      ? String(lookupHelp.stdout).replace(/\x1b\[[0-9;]*m/g, "").slice(0, 3600) : "";
    const message = recipients.length
      ? `ACTION_CHECK_EVIDENCE_REQUIRED: This call was NOT run: the recipient address ${recipients.map(r => r.value).join(", ")} is not established by the request or a successful lookup. Run ${parentHelp} to find a command that reads or searches the relevant correspondence, or find a contact lookup from --help. Read the matching record, then use the exact address from that result and continue. Do not infer an address from a name. Ask the requester only if those lookups cannot establish the address.${lookupReference ? `\nInstalled CLI lookup reference (documentation only; pass command paths to executeAux4):\n${lookupReference}` : ""}`
      : repeatedReadGuardMessage(options.command, attempts);
    if (message) {
      process.stdout.write(`${message}\n`);
      process.exit(1);
    }
    if (options.guardOptions) {
      const config = JSON.parse(fs.readFileSync(options.guardOptions, "utf8"));
      // __history is a temporary live snapshot supplied by ai-agent's hook
      // runtime. Keep audit histories next to the actual conversation so its
      // metrics and the caller's artifact collection include every check.
      const verdict = authorizeAction(config, options.command, attempts, options.request, config.history || options.history, reference);
      if (!verdict.allow) {
        process.stdout.write(`ACTION_CHECK_SCOPE_DENIED: This call was NOT run: ${verdict.reason} Check the target and requested scope against the existing facts, obtain missing evidence if needed, and continue with the authorized work.\n`);
        process.exit(1);
      }
    }
    process.exit(0);
  }
  const unsourced = checkValues(options);
  const incomplete = unsourced.find(u => u.emptyFields);
  if (incomplete) {
    process.stdout.write(`This call was NOT run: "${incomplete.action}" cannot be undone and the form still has empty fields: ${incomplete.emptyFields.join(", ")}. Fill each one with a value from the request or a tool result (run again without confirm), or, if a value cannot be found, stop and ask the person for it.\n`);
    process.exit(1);
  }
  const unclear = unsourced.find(u => u.unclear);
  if (unclear) {
    process.stdout.write(`This call was NOT run: the request does not say which item "${unclear.action}" should act on, and it cannot be undone. Do not confirm it. Stop and ask the person to confirm exactly this action (name it), and wait for their answer.\n`);
    process.exit(1);
  }
  if (unsourced.some(u => u.notAsked)) {
    process.stdout.write("This call was NOT run: it confirms an action, but nothing has asked for a confirmation yet. Run it without confirm; when the tool stops and asks, confirm exactly what it names, only if the request asks for it.\n");
    process.exit(1);
  }
  if (unsourced.length) {
    process.stdout.write(`${composeNotConfirmedQuestion(unsourced)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

function isEntryPoint() {
  try {
    return process.argv[1] && process.argv[1].endsWith("check-values.mjs");
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
