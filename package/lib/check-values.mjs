#!/usr/bin/env node
import fs from "node:fs";
// `aux4 agent check-values` -- a `before` hook target for aux4/ai-agent's
// tool-call hooks (HARN-030). Wired in agent-loop.mjs's checkValuesHooksFile
// as a `before` hook on every `agent:browser/run` call: a made-up value is
// stopped where it is typed, and a confirmation re-checks everything typed before it.
//
// Checks the PENDING call's own --field values (passed as --fieldsJson, the
// hook's ${field} context var -- a JSON array when the call repeated --field,
// or a plain string when it didn't) against everything that happened before
// it in this round: the original request plus every earlier tool result.
// Exits non-zero (blocking the call -- see aux4/ai-agent's `before` phase)
// and prints the same message the two-round confirmation gate would have
// asked for, when any value cannot be found anywhere. Exits 0 silently
// otherwise, letting the confirmation run.
import { extractAttemptLog, unsourcedFieldValues, composeNotConfirmedQuestion, enteredValues, dataEntries, pendingConfirmation, hasConfirmationContract, namesUnselectedItem } from "./agent-loop.mjs";

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

export function checkValues({ request = "", history = "", fieldsJson = "", dataJson = "" } = {}) {
  // --data JSON values are checked exactly like --field values.
  const dataFields = dataEntries(dataJson).map(e => `${e.label}=${e.value}`);
  const dataConfirms = (() => {
    try {
      const v = JSON.parse(dataJson || "");
      return Boolean(v && typeof v === "object" && Object.entries(v).some(([k, x]) => /^confirm$/i.test(k) && (x === true || /^yes$/i.test(String(x)))));
    } catch { return false; }
  })();
  const fields = [...parseFields(fieldsJson), ...dataFields, ...(dataConfirms ? ["confirm=yes"] : [])];
  const attempts = extractAttemptLog(history);
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
  // The person's original request, when the harness wrote it next to the history.
  if (options.requestFile) {
    try { options.request = fs.readFileSync(options.requestFile, "utf8"); } catch {}
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
