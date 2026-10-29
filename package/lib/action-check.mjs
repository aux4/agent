import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isChangeCommand, runAux4, parseJSONLoose, commandWords } from "./agent-loop.mjs";
export { actionCheckFiles, actionCheckStats } from "./agent-loop.mjs";

export function authorizeAction(options, command, attempts = [], request = "", history = "") {
  if (!isChangeCommand(command) || /(?:^|\s)--help(?:\s|$)/.test(command)) return { allow: true, skipped: true };
  // A registered goal-level delegate owns inspection and its own action
  // guards. Do not require the parent to know the page's target records before
  // the delegate can inspect them. Concrete leaf writes remain checked here.
  const words = commandWords(command) || [];
  const unprefixed = words[0] === 'aux4' ? words.slice(1) : words;
  if ((options.delegatedPrefixes || []).some(prefix => {
    const parts = commandWords(prefix) || [];
    return parts.length > 0 && parts.every((part, index) => unprefixed[index] === part);
  })) return { allow: true, skipped: true, delegated: true };
  // Keep command/result pairs together: a target's membership in a query is
  // evidence, while the target identifier on its own may mean nothing.
  let remaining = 24000;
  const evidence = attempts.filter(a => a.completed !== false && !a.failed && !/(?:^|\s)--help(?:\s|$)/.test(a.command)).map(a => {
    const result = String(a.source ?? a.result ?? "").slice(0, Math.min(4000, remaining));
    remaining -= result.length;
    return { command: a.command, result };
  });
  const payload = { request, proposedAction: command, successfulActionsAndResults: evidence };
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
  const result = runAux4(args, { allowFailure: true, timeout: 45000 });
  const parsed = result.ok ? parseJSONLoose(result.stdout, null) : null;
  const verdict = { allow: parsed?.allow === true, reason: String(parsed?.reason || "The proposed change could not be verified against the request and evidence.").slice(0, 500) };
  if (auditBase) fs.writeFileSync(`${auditBase}.verdict.json`, JSON.stringify(verdict, null, 2));
  return verdict;
}
