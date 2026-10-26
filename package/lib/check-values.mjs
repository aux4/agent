#!/usr/bin/env node
// `aux4 agent check-values` -- a `before` hook target for aux4/ai-agent's
// tool-call hooks (HARN-030). Wired in agent-loop.mjs's checkValuesHooksFile
// as a `before` hook on `agent:browser/run` gated on `field` containing
// "confirm=yes", so it only ever runs against the confirmation call.
//
// Checks the PENDING call's own --field values (passed as --fieldsJson, the
// hook's ${field} context var -- a JSON array when the call repeated --field,
// or a plain string when it didn't) against everything that happened before
// it in this round: the original request plus every earlier tool result.
// Exits non-zero (blocking the call -- see aux4/ai-agent's `before` phase)
// and prints the same message the two-round confirmation gate would have
// asked for, when any value cannot be found anywhere. Exits 0 silently
// otherwise, letting the confirmation run.
import { extractAttemptLog, unsourcedFieldValues, composeNotConfirmedQuestion } from "./agent-loop.mjs";

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

export function checkValues({ request = "", history = "", fieldsJson = "" } = {}) {
  const fields = parseFields(fieldsJson);
  const attempts = extractAttemptLog(history);
  return unsourcedFieldValues(fields, attempts, request);
}

async function main(argv) {
  const options = parseArgs(argv);
  const unsourced = checkValues(options);
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
