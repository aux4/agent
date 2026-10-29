import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isChangeCommand, runAux4, parseJSONLoose, commandWords } from "./agent-loop.mjs";
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
    && !/(?:^|\s)--help(?:\s|$)/.test(a.command)).map(a => a.source ?? a.result ?? "")].map(String);
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

export function authorizeAction(options, command, attempts = [], request = "", history = "", commandReference = undefined) {
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
  const payload = { request, proposedAction: command, successfulActionsAndResults: evidence,
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
  const unknownIds = unsourcedActionIds(command, attempts, request, payload.commandReference);
  if (unknownIds.length) {
    const verdict = { allow: false, reason: `The target identifier ${unknownIds.map(item => item.value).join(", ")} is not established by the request or successful tool evidence. Look up the named target before changing it.` };
    if (auditBase) fs.writeFileSync(`${auditBase}.verdict.json`, JSON.stringify(verdict, null, 2));
    return verdict;
  }
  const result = runAux4(args, { allowFailure: true, timeout: 45000 });
  const parsed = result.ok ? parseJSONLoose(result.stdout, null) : null;
  const verdict = { allow: parsed?.allow === true, reason: String(parsed?.reason || "The proposed change could not be verified against the request and evidence.").slice(0, 500) };
  if (auditBase) fs.writeFileSync(`${auditBase}.verdict.json`, JSON.stringify(verdict, null, 2));
  return verdict;
}
