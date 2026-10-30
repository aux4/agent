import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isChangeCommand, runAux4, parseJSONLoose, commandWords, enteredValues, confirmsAction, unsourcedFieldValues, fieldEvidenceText, availableFieldChoices, explicitOpenChoice, isConclusiveAttempt } from "./agent-loop.mjs";
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
  if (attempts.some(attempt => isConclusiveAttempt(attempt) && canonical(attempt.command) === canonical(command))) {
    return {allow: false, reason: "This exact change already succeeded. Reuse its result instead of performing it again."};
  }
  const confirming = confirmsAction(command);
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
    return { command: a.command, result, suppliedFields: enteredValues(a.command) };
  });
  const payload = { request, proposedAction: command, delegatedGoal, confirming,
    proposedFields: [...staged].map(([label, value]) => ({label, value})),
    explicitlyPermittedChoices: candidateFields.filter(entry=>explicitOpenChoice(entry.label,entry.value,attempts,request)), successfulActionsAndResults: evidence,
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
  const verdict = { allow: Boolean(valid && parsed.allow), reason: valid ? String(parsed.reason || (parsed.allow ? "Authorized by the action check." : "Denied by the action check.")).slice(0,500) : "The authorization check did not return a valid decision. This action was not run; more factual lookups cannot repair the check's output format.", ...(formatRecovery ? {formatRecovery:true} : {}), ...(!valid ? {protocolError:true} : {}) };
  if (auditBase) fs.writeFileSync(`${auditBase}.verdict.json`, JSON.stringify(verdict, null, 2));
  return { ...verdict, ...(delegatedGoal ? {delegated: true} : {}) };
}
