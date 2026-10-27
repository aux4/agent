#!/usr/bin/env node
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
import { extractAttemptLog, unsourcedFieldValues, composeNotConfirmedQuestion, enteredValues, dataEntries } from "./agent-loop.mjs";

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
  return unsourcedFieldValues([...new Set([...fields, ...earlier])], attempts, request);
}

// A confirmation only answers a tool that stopped and asked for one this round:
// an earlier result that is still waiting (needs-input) and offers confirm=yes.
export function confirmationWasAsked(attempts) {
  return attempts.some(a => {
    const text = String(a.source ?? a.result ?? "");
    return !a.failed && /needs-input/i.test(text) && /confirm=yes/i.test(text);
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  const unsourced = checkValues(options);
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
