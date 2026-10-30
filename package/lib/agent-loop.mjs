#!/usr/bin/env node
// Generic plan -> execute -> verify -> diagnose -> retry loop around a single
// `aux4 ai agent ask` execution turn. Nothing here may reference a specific
// service, tool, or task domain -- only goals, outcomes, evidence, attempts,
// and failure types. The loop is orchestrated entirely through repeated
// `aux4 ai agent ask` invocations; no change is made to aux4/ai-agent itself.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const RETRY_BUDGET = 2;
// How much of each tool result the verifier sees, and in total.
const RESULT_LIMIT = 800;
const RESULTS_TOTAL_LIMIT = 4000;
// How much of each tool result is kept to check where entered values came from.
const SOURCE_LIMIT = 50000;
const FAILURE_CLASSES = ["wrong_tool", "wrong_parameters", "tool_error", "incomplete", "misread_facts", "blocked"];

export function runAux4(args, { allowFailure = false, timeout = 0 } = {}) {
  const result = spawnSync(process.env.AUX4_BIN || "aux4", args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    ...(timeout ? { timeout, killSignal: "SIGKILL" } : {})
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.error || result.status !== 0) {
    if (allowFailure) return { ok: false, stdout, stderr, status: result.status ?? 1 };
    const detail = stderr.trim() || stdout.trim() || result.error?.message || "unknown aux4 error";
    throw new Error(detail);
  }
  return { ok: true, stdout, stderr, status: 0 };
}

// Tolerant JSON extraction: strip code fences, try a straight parse, then fall
// back to scanning for the first balanced {...} or [...] substring. Never
// throws -- returns `fallback` when nothing usable is found.
export function parseJSONLoose(text, fallback) {
  if (!text) return fallback;
  let candidate = String(text).trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace scanning
  }
  const openers = { "{": "}", "[": "]" };
  for (let i = 0; i < candidate.length; i++) {
    const close = openers[candidate[i]];
    if (!close) continue;
    let depth = 0;
    for (let j = i; j < candidate.length; j++) {
      if (candidate[j] === candidate[i]) depth++;
      else if (candidate[j] === close) {
        depth--;
        if (depth === 0) {
          const slice = candidate.slice(i, j + 1);
          try {
            return JSON.parse(slice);
          } catch {
            break;
          }
        }
      }
    }
  }
  return fallback;
}

function planInstructionsPath(packageDir) {
  return path.join(packageDir, "instructions", "loop-plan.md");
}

function verifyInstructionsPath(packageDir) {
  return path.join(packageDir, "instructions", "loop-verify.md");
}

// Plan and verify calls stay inside the same guardrails as the real run --
// same tool surface, same policy budget, same command/file permissions --
// just with their own throwaway conversation and a different instructions file.
function sharedExtraArgs(options) {
  const args = [];
  if (options.tools) args.push("--tools", options.tools);
  if (options.permissions) args.push("--permissions", options.permissions);
  if (options.policy) args.push("--policy", options.policy);
  return args;
}

function askOnce(options, { instructions, question, history = "", extraArgs = [] }) {
  const args = ["ai", "agent", "ask", "--configFile", options.configFile || "config.yaml"];
  if (options.config) args.push("--config", options.config);
  args.push("--instructions", instructions);
  if (history) args.push("--history", history);
  args.push(...extraArgs, "--question", question);
  return runAux4(args, { allowFailure: true, timeout: HELPER_TIMEOUT_MS });
}

// --- Plan -------------------------------------------------------------

// A criterion is either about the reply ("answer": what the final answer must
// say) or about the world ("state": something that must now be true outside
// the conversation). Only state criteria need the verifier to look again.
function normalizeCriterion(raw) {
  if (typeof raw === "string") return { text: raw.trim(), kind: "state" };
  const text = typeof raw?.text === "string" ? raw.text.trim() : typeof raw?.criterion === "string" ? raw.criterion.trim() : "";
  const kind = raw?.kind === "answer" ? "answer" : "state";
  return { text, kind };
}

function normalizePlan(raw) {
  const goal = typeof raw?.goal === "string" && raw.goal.trim() ? raw.goal.trim() : "";
  const criteria = Array.isArray(raw?.doneCriteria)
    ? raw.doneCriteria.map(normalizeCriterion).filter(c => c.text)
    : [];
  const steps = Array.isArray(raw?.steps)
    ? raw.steps.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  const lookFor = Array.isArray(raw?.lookFor)
    ? raw.lookFor.map(String).map(s => s.trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    goal,
    doneCriteria: criteria.map(c => c.text),
    stateCriteria: criteria.filter(c => c.kind === "state").map(c => c.text),
    steps,
    lookFor
  };
}

export function fallbackPlan(request) {
  return {
    goal: String(request || "").trim(),
    doneCriteria: ["the request has been fully and correctly carried out"],
    stateCriteria: ["the request has been fully and correctly carried out"],
    steps: []
  };
}

// Planning needs no tools, but ai-agent binds every tool when the list is
// empty or matches nothing. Bind one tiny argument-free tool: if a model loops
// on it, ai-agent's own repeat guard stops identical calls after three.
const PLAN_TOOLS = "currentDateTime";
// Hard cap on any single helper call (plan, pick, verdict) so a looping model
// can never hang the run.
const HELPER_TIMEOUT_MS = 90000;

export function buildPlan(options, planHistory = "") {
  if (planHistory) fs.rmSync(planHistory, { force: true });
  const delegate = preferredDelegation(options.request, options.delegations || []);
  const capability = delegate ? `\n\nAlready registered goal capability: ${delegate.planningScope || delegate.note || delegate.via}. In lookFor, name only additional capabilities outside this scope; use an empty array when it covers all the work.` : "";
  const result = askOnce(options, {
    instructions: planInstructionsPath(options.packageDir),
    history: planHistory,
    question: `Request:\n${options.request}${capability}\n\nRespond with ONLY the JSON plan object described in your instructions. No prose, no code fences.`,
    extraArgs: ["--tools", PLAN_TOOLS]
  });
  const parsed = parseJSONLoose(result.stdout, null);
  const plan = parsed ? normalizePlan(parsed) : fallbackPlan(options.request);
  if (!plan.goal) plan.goal = String(options.request || "").trim();
  if (plan.doneCriteria.length === 0) {
    const fallback = fallbackPlan(options.request);
    plan.doneCriteria = fallback.doneCriteria;
    plan.stateCriteria = fallback.stateCriteria;
  }
  return plan;
}

export function phaseHistoryPath(historyFile, phase) {
  if (!historyFile) return "";
  const base = historyFile.endsWith(".json") ? historyFile.slice(0, -5) : historyFile;
  return `${base}.${phase}.json`;
}

export function planFilePath(historyFile) {
  if (!historyFile) return "";
  return historyFile.endsWith(".json") ? historyFile.slice(0, -5) + ".plan.json" : `${historyFile}.plan.json`;
}

export function savePlan(historyFile, plan) {
  const file = planFilePath(historyFile);
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  } catch {
    // best-effort; the loop still works without a persisted plan file
  }
}

// --- Attempt log --------------------------------------------------------

function getToolCalls(message) {
  const content = message?.content;
  if (!content || typeof content !== "object") return [];
  if (Array.isArray(content.tool_calls)) return content.tool_calls;
  if (content.kwargs && Array.isArray(content.kwargs.tool_calls)) return content.kwargs.tool_calls;
  const raw = content.additional_kwargs?.tool_calls || content.kwargs?.additional_kwargs?.tool_calls;
  if (Array.isArray(raw)) {
    return raw.map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      args: parseJSONLoose(tc.function?.arguments, {})
    }));
  }
  return [];
}

function isFailedResult(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  return /^\s*(error\b|permission denied|command not found|timeout:|blocked by hook:|not run:|aborting:)/i.test(text)
    || /⛔\s*policy\b/i.test(text)
    || isDeclinedResult(text);
}

export function isBudgetExceededResult(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  return /⛔\s*policy\s+budget_exceeded\b/i.test(text)
    || /budget exceeded\s*\(spent .*\bcap\b/i.test(text);
}

function isNoProgressAbort(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  return /aborting:\s*the same (?:call has been refused|action has returned the same result)\b/i.test(text);
}

function repeatsWithoutNewResult(attempts, count = 3) {
  if (attempts.length < count) return false;
  const recent = attempts.slice(-count);
  const command = recent[0]?.command;
  if (!command || recent.some(attempt => attempt.command !== command || !attempt.source)) return false;
  // Ignore transient request/session metadata so a fresh session ID or score
  // cannot make an unchanged answer look like new progress.
  const evidence = recent.map(readEvidenceKey);
  return Boolean(evidence[0]) && evidence.every(key => key === evidence[0]);
}

// Run an execution turn while watching its persisted tool history. Once the
// agent runtime says its call/token budget is exhausted, every later tool call
// is denied anyway; terminate the inner generation instead of letting it
// replay an ever-growing transcript of denials. Kill the process group so a
// shell wrapper cannot leave its node child running in the background.
export function runAux4Monitored(args, historyFile, { pollInterval = 100, env = {} } = {}) {
  const bin = process.env.AUX4_BIN || "aux4";
  // Old refusals belong to the previous invocation, not this recovery attempt.
  const completedBefore = new Set(extractAttemptLog(historyFile)
    .filter(attempt => attempt.completed).map(attempt => attempt.callId));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        env: {...process.env,...env},
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let stopReason = "";
    const stop = reason => {
      if (stopReason) return;
      stopReason = reason;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > 20 * 1024 * 1024 ? next.slice(-20 * 1024 * 1024) : next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });

    const monitor = setInterval(() => {
      if (stopReason || !historyFile || !fs.existsSync(historyFile)) return;
      const attempts = extractAttemptLog(historyFile)
        .filter(attempt => attempt.completed && !completedBefore.has(attempt.callId));
      if (attempts.some(attempt => isBudgetExceededResult(attempt.source))) {
        stop("budget");
        return;
      }
      const last = attempts.at(-1);
      const previous = attempts.at(-2);
      if (last && isDeterministicToolFailure(last.source) && isNoProgressAbort(last.source)) {
        stop("no-progress");
        return;
      }
      if (repeatsWithoutNewResult(attempts)) {
        stop("no-progress");
        return;
      }
      if (last && previous && last.failed && previous.failed
        && last.command === previous.command
        && isDeterministicToolFailure(last.source)
        && last.source.trim().replace(/\s+/g, " ") === previous.source.trim().replace(/\s+/g, " ")) {
        stop("no-progress");
      }
    }, Math.max(25, pollInterval));

    child.on("error", error => {
      clearInterval(monitor);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearInterval(monitor);
      resolve({
        ok: code === 0 && !stopReason,
        status: code ?? 1,
        signal,
        stdout,
        stderr,
        budgetExceeded: stopReason === "budget",
        noProgress: stopReason === "no-progress"
      });
    });
  });
}

function isDeterministicToolFailure(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  return /command not found|invalid (?:command|arguments?|option)|unknown (?:command|option)|blocked by hook:|permission denied|not run: you have already made this exact call/i.test(text)
    || isNoProgressAbort(text);
}

// The requester was asked to confirm an action and did not. Retrying cannot
// fix that, so the loop stops instead of asking again.
export function isDeclinedResult(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content || "");
  return /\buser aborted\b/i.test(text);
}

function describeCall(name, args) {
  if (name === "executeAux4" && args && typeof args.command === "string") return args.command;
  try {
    return `${name} ${JSON.stringify(args)}`;
  } catch {
    return name;
  }
}

// Reads an ai-agent history JSON file and derives, in order, every action the
// model actually took: which tool, with what parameters, and whether it
// errored. Defensive against any shape it does not recognize -- a message it
// cannot parse is simply skipped rather than crashing the loop.
// A tool's JSON result is compacted field by field before it is cut to size,
// so its short, telling fields (status, the steps it took, what it changed,
// the next command) are never pushed out by one long field ahead of them.
// Long strings are shortened, short lists kept, nested data summarized.
// Non-JSON results are just cut.
// A list of objects keeps each item's own short identifying text (a row's text,
// a name, a title...), so a list of results never collapses to just a count.
const ITEM_TEXT_KEYS = ["text", "name", "title", "label", "summary", "subject", "snippet", "id"];
function summarizeItems(items, short) {
  const texts = items.slice(0, 12).map(item => {
    if (!item || typeof item !== "object") return short(item, 120);
    const key = ITEM_TEXT_KEYS.find(k => typeof item[k] === "string" || typeof item[k] === "number");
    return key ? short(String(item[key]), 160) : `{${Object.keys(item).length} fields}`;
  });
  return texts.concat(items.length > 12 ? [`… ${items.length - 12} more`] : []);
}

export function compactResult(text, limit = RESULT_LIMIT) {
  const raw = String(text ?? "");
  if (raw.length <= limit) return raw;
  let value;
  try { value = JSON.parse(raw); } catch { return raw.slice(0, limit); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return raw.slice(0, limit);
  const short = (v, n) => (typeof v === "string" && v.length > n ? `${v.slice(0, n)}…` : v);
  const out = {};
  const priority = ["status", "submitted", "confirmation", "needsInput", "missing", "reason", "lastFormControlStates", "observations", "stepsText", "finalUrl", "answer", "summary"];
  const keys = [...priority.filter(key => Object.hasOwn(value, key)), ...Object.keys(value).filter(key => !priority.includes(key))];
  for (const key of keys) {
    const v = value[key];
    if (v === null || typeof v !== "object") out[key] = short(v, 240);
    else if (key === "lastFormControlStates" && !Array.isArray(v)) {
      out[key] = { url: short(v.url, 160), controls: Array.isArray(v.controls) ? v.controls.slice(0, 12).map(x => short(x, 160)) : [] };
    }
    else if (key === "observations" && !Array.isArray(v)) {
      const size = Math.min(1600, Math.max(120, Math.floor((limit - 250) / 2)));
      out[key] = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string").map(([k, x]) => [k, short(x, size)]));
    }
    else if (key === "confirmation" && v && !Array.isArray(v)) {
      out[key] = {
        action: short(v.action, 120),
        target: short(v.target, 200),
        emptyFields: Array.isArray(v.emptyFields) ? v.emptyFields.slice(0, 12).map(x => short(x, 120)) : [],
        next: v.next
      };
    }
    else if (Array.isArray(v)) {
      out[key] = v.every(x => x === null || typeof x !== "object")
        ? v.slice(0, 12).map(x => short(x, 120)).concat(v.length > 12 ? [`… ${v.length - 12} more`] : [])
        : summarizeItems(v, short);
    } else {
      const keys = Object.keys(v);
      out[key] = keys.length <= 8 && keys.every(k => v[k] === null || typeof v[k] !== "object")
        ? Object.fromEntries(keys.map(k => [k, short(v[k], 120)]))
        : `{${keys.length} fields}`;
    }
  }
  return JSON.stringify(out).slice(0, limit);
}

export function extractAttemptLog(historyFile) {
  if (!historyFile || !fs.existsSync(historyFile)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  } catch {
    return [];
  }
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const resultsById = new Map();
  for (const message of messages) {
    if (message?.role === "tool" && message.tool_call_id) {
      resultsById.set(message.tool_call_id, message);
    }
  }
  const attempts = [];
  for (const message of messages) {
    if (message?.role !== "assistant_with_tool") continue;
    for (const call of getToolCalls(message)) {
      if (!call || !call.name) continue;
      const result = call.id ? resultsById.get(call.id) : undefined;
      const resultContent = result ? result.content : undefined;
      const failed = result ? isFailedResult(resultContent) : false;
      const resultText = typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent ?? "");
      attempts.push({
        callId: call.id,
        tool: call.name,
        args: call.args ?? {},
        command: describeCall(call.name, call.args),
        completed: result !== undefined,
        failed,
        declined: result ? isDeclinedResult(resultContent) : false,
        result: compactResult(resultText, RESULT_LIMIT),
        source: resultText.slice(0, SOURCE_LIMIT),
        resultSummary: resultText.slice(0, 300)
      });
    }
  }
  return attempts;
}

// --- Metrics ----------------------------------------------------------------

const NUDGE = /^you returned nothing\b/i;
const PROTOCOL_RECOVERY = /^the provider returned an unusable tool request\b/i;

export function readTokenUsage(historyFile) {
  if (!historyFile || !fs.existsSync(historyFile)) return { input: 0, cached: 0, output: 0 };
  try {
    const u = JSON.parse(fs.readFileSync(historyFile, "utf8"))?.tokenUsage || {};
    return { input: u.input || 0, cached: u.cached || 0, output: u.output || 0 };
  } catch {
    return { input: 0, cached: 0, output: 0 };
  }
}

function readMessages(historyFile) {
  if (!historyFile || !fs.existsSync(historyFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    return Array.isArray(data?.messages) ? data.messages : [];
  } catch {
    return [];
  }
}

function usageOf(message) {
  const c = message?.content;
  const meta = c?.kwargs?.response_metadata || c?.response_metadata || {};
  const u = meta.tokenUsage || {};
  const cached = meta.usage?.prompt_tokens_details?.cached_tokens || 0;
  return { input: u.promptTokens || 0, output: u.completionTokens || 0, cached };
}

// Counts what one phase spent, from its history file (optionally only the
// messages after `from`): model calls, tokens, tool calls, and the calls that
// bought nothing -- failed or denied, exact repeats, help lookups, and empty
// replies the model had to be nudged past.
// Token totals come from the history's own tokenUsage (pass `usageBefore` to
// get only what was spent after it); every assistant message, and every empty
// reply the model was nudged past, is one model call.
export function historyStats(historyFile, from = 0, usageBefore = null) {
  const messages = readMessages(historyFile).slice(from);
  const stats = { modelCalls: 0, input: 0, cached: 0, output: 0, toolCalls: 0, failed: 0, repeats: 0, help: 0, emptyReplies: 0 };
  const seen = new Set();
  const results = new Map();
  for (const m of messages) if (m?.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m.content);
  for (const m of messages) {
    if (m?.role === "user" && NUDGE.test(String(m.content || ""))) {
      stats.emptyReplies++;
      stats.modelCalls++;
    }
    if (m?.role === "user" && PROTOCOL_RECOVERY.test(String(m.content || ""))) {
      stats.protocolErrors = (stats.protocolErrors || 0) + 1;
      stats.modelCalls++;
    }
    if (m?.role !== "assistant" && m?.role !== "assistant_with_tool") continue;
    stats.modelCalls++;
    if (PROTOCOL_RECOVERY.test(String(m.content || ""))) stats.protocolErrors = (stats.protocolErrors || 0) + 1;
    const u = usageOf(m);
    stats.input += u.input;
    stats.cached += u.cached;
    stats.output += u.output;
    for (const call of getToolCalls(m)) {
      if (!call?.name) continue;
      stats.toolCalls++;
      if (call.name === "__tool_protocol_error__") stats.protocolErrors = (stats.protocolErrors || 0) + 1;
      const command = describeCall(call.name, call.args);
      if (seen.has(command)) stats.repeats++;
      seen.add(command);
      if (/(^|\s)--help(\s|$)/.test(command)
        || String(results.get(call.id) || "").includes("Local command parameter reference (--help; no action retried):")) stats.help++;
      if (call.id && isFailedResult(results.get(call.id))) stats.failed++;
    }
  }
  const total = readTokenUsage(historyFile);
  if (total.input || total.output) {
    const before = usageBefore || { input: 0, cached: 0, output: 0 };
    stats.input = total.input - before.input;
    stats.cached = total.cached - before.cached;
    stats.output = total.output - before.output;
  }
  return stats;
}

export function addStats(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (typeof v === "number") out[k] = (out[k] || 0) + v;
  return out;
}

export function actionCheckFiles(history) {
  if (!history || !fs.existsSync(path.dirname(history))) return [];
  const prefix = `${path.basename(history)}.action-check-`;
  return fs.readdirSync(path.dirname(history))
    .filter(name => name.startsWith(prefix) && name.endsWith(".history.json"))
    .map(name => path.join(path.dirname(history), name));
}

export function actionCheckStats(history, previous = new Set()) {
  return actionCheckFiles(history).filter(file => !previous.has(file))
    .reduce((stats, file) => addStats(stats, historyStats(file)), {});
}

export function metricsPath(historyFile) {
  return phaseHistoryPath(historyFile, "metrics");
}

export function saveMetrics(historyFile, metrics) {
  const file = metricsPath(historyFile);
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(metrics, null, 2));
  } catch {
    // best-effort
  }
}

export function summarizeAttemptLog(attempts) {
  if (!attempts.length) return "(no actions were taken)";
  return attempts
    .map((a, i) => `${i + 1}. ${a.command} -> ${a.failed ? "FAILED: " : "ok: "}${a.resultSummary}`)
    .join("\n");
}

// --- Verify ---------------------------------------------------------------

function normalizeVerdict(raw, doneCriteria) {
  const results = Array.isArray(raw?.results) ? raw.results : [];
  const byCriterion = new Map();
  for (const r of results) {
    const criterion = typeof r?.criterion === "string" ? r.criterion.trim() : "";
    if (!criterion) continue;
    const status = ["pass", "fail", "unverifiable"].includes(r?.status) ? r.status : "unverifiable";
    const evidence = typeof r?.evidence === "string" ? r.evidence.trim() : "";
    byCriterion.set(criterion, { criterion, status, evidence, ...normalizeAssessment(r) });
  }
  // Every fixed done-criterion must have a verdict; a criterion the verifier
  // silently dropped is treated as unverifiable, never as a pass.
  // Match by exact text first; small models often reword the criterion, so
  // fall back to position (the verifier is asked to answer in order).
  const ordered = results.filter(r => typeof r?.criterion === "string" || typeof r?.status === "string");
  const knownLabels = new Set(doneCriteria);
  const criteria = doneCriteria.map((c, i) => {
    const exact = byCriterion.get(c);
    if (exact) return exact;
    const r = ordered[i];
    const returnedLabel = typeof r?.criterion === "string" ? r.criterion.trim() : "";
    if (r && !knownLabels.has(returnedLabel) && ["pass", "fail", "unverifiable"].includes(r.status)) {
      return { criterion: c, status: r.status, evidence: typeof r.evidence === "string" ? r.evidence.trim() : "", ...normalizeAssessment(r) };
    }
    return { criterion: c, status: "unverifiable", evidence: "the verifier did not report on this outcome" };
  });
  const overall = criteria.every(c => c.status === "pass") ? "pass" : "fail";
  return { overall, criteria };
}

function normalizeAssessment(result) {
  const out = {};
  if (["currentState", "actionResult", "answer"].includes(result?.basis)) out.basis = result.basis;
  if (["supports", "contradicts", "unknown"].includes(result?.relation)) out.relation = result.relation;
  if (["complete", "partial", "unknown"].includes(result?.coverage)) out.coverage = result.coverage;
  if (["presence", "absence", "other"].includes(result?.claim)) out.claim = result.claim;
  return out;
}

export function fallbackVerdict(doneCriteria, reason) {
  return {
    overall: "fail",
    criteria: doneCriteria.map(c => ({ criterion: c, status: "unverifiable", evidence: reason }))
  };
}

// Every request also gets one implicit answer criterion, so a reply that
// silently skips part of what was asked cannot pass.
export const COVERAGE_CRITERION = "The final answer responds to every part of the request, using the request's own meaning";
// And one implicit honesty criterion: the answer must match what the actions
// actually did -- what was sent, changed, or found -- not what was intended.
export const HONESTY_CRITERION = "The final answer accurately describes what the actions actually did, including the exact content of anything sent or changed";
// And one implicit agreement criterion: a planner can state the right actions
// while the content sent still contradicts what the tools found (e.g. a reply
// says "available" when a prior check returned a conflicting busy slot).
// Coverage and honesty alone do not catch this -- neither asks whether a sent
// claim actually agrees with the facts -- so it is checked on its own.
export const AGREEMENT_CRITERION = "Anything sent, submitted, or saved states only facts that agree with what the tool results showed";

// A state criterion phrased as an absence of change ("nothing was changed",
// "no changes were made to the site", "without modifying the record") needs
// no fresh observation to decide: if no change-verb command ran at all, there
// is nothing that could have changed, and that fact is already in the attempt
// log the harness holds, not something only a later look could show.
const NO_CHANGE_CRITERION = /\bno\b[^.]*\b(change|changes|modification|modifications)\b|\bnothing\b[^.]*\b(changed|modified|submitted|sent|updated|created|deleted|removed|written|saved)\b|\bwithout\b[^.]*\b(chang\w*|modif\w*|submit\w*|send\w*|sent|updat\w*|creat\w*|delet\w*)\b/i;

export function isNoChangeCriterion(criterion) {
  return NO_CHANGE_CRITERION.test(String(criterion || ""));
}

// A pass on a state criterion only counts when it rests on the verifier's own
// observation made after the work. If the verify run made no checks of its
// own, those passes become unverifiable -- except a no-change criterion when
// no change-verb command ran: the attempt log alone already proves it, so it
// is marked pass instead of unverifiable. Answer criteria are judged from the
// recorded tool results, so they need no new check.
export function requireOwnObservation(verdict, checks, stateCriteria = null, attempts = []) {
  if (checks.length > 0) return verdict;
  const isState = c => stateCriteria === null || stateCriteria.includes(c.criterion);
  const noChangeRan = !attempts.some(a => !a.failed && CHANGE_VERB.test(a.command));
  // Earlier results show the state before or during the work, so neither a
  // pass nor a fail on a state criterion can rest on them alone.
  const criteria = verdict.criteria.map(c => {
    if (c.status === "unverifiable" || !isState(c)) return c;
    if (noChangeRan && isNoChangeCriterion(c.criterion)) {
      return { ...c, status: "pass", evidence: "no action that could change anything was run in this attempt, so nothing changed" };
    }
    return { ...c, status: "unverifiable", evidence: `not observed by the verifier itself (it made no checks of its own)${c.evidence ? `; it said: ${c.evidence}` : ""}` };
  });
  return { overall: criteria.every(c => c.status === "pass") ? "pass" : "fail", criteria };
}

// What the verifier is given: the request verbatim, the criteria with their
// kind, the final answer, and every action with its raw result. Raw results
// are real observations the answer must agree with; they say nothing about the
// state after the work, which state criteria must look at again.
export function verifyPayload(plan, finalAnswer, attempts, request = "") {
  let budget = RESULTS_TOTAL_LIMIT;
  const perAction = Math.max(RESULT_LIMIT, Math.floor(RESULTS_TOTAL_LIMIT / Math.max(1, attempts.length)));
  const actions = [];
  for (const a of [...attempts].reverse()) {
    const available = Math.max(0, Math.min(perAction, budget));
    const result = available ? compactResult(a.source ?? a.result ?? a.resultSummary ?? "", available) : "";
    budget -= result.length;
    actions.unshift({ action: a.command, failed: Boolean(a.failed), result });
  }
  const state = new Set(plan.stateCriteria || plan.doneCriteria);
  return {
    request: String(request || plan.goal || ""),
    criteria: verifyCriteria(plan).map(c => ({ criterion: c, kind: state.has(c) ? "state" : "answer" })),
    finalAnswer: String(finalAnswer || ""),
    actions
  };
}

export function verifyCriteria(plan) {
  return [...plan.doneCriteria, COVERAGE_CRITERION, HONESTY_CRITERION, AGREEMENT_CRITERION];
}

// Commands that already worked in this run, minus help lookups: the verifier
// re-runs whichever of them reads the item rather than guessing a new one.
export function readBackCandidates(attempts, limit = 5) {
  const seen = new Set();
  const out = [];
  for (const a of attempts) {
    const command = a.command;
    if (a.tool !== "executeAux4" || a.failed || !command || /(^|\s)--help(\s|$)/.test(command) || seen.has(command)) continue;
    seen.add(command);
    out.push(command);
  }
  return out.slice(-limit);
}

// --- Harness read-back ------------------------------------------------------
//
// Small models rarely call a tool while verifying, so the harness reads the
// current state itself: a tiny call picks which already-successful command
// re-reads the item, and the harness re-runs it. Only a command that already
// ran successfully in this run (so permissions allowed it) and that carries no
// change verb is ever re-run.

export const CHANGE_VERB = /\b(send|reply|forward|delete|remove|rm|trash|archive|update|patch|put|post|create|insert|add|set|write|move|cancel|modify|edit|rename|upload|publish|deploy|pay|approve|install|uninstall|save|submit|book|confirm|run)\b/i;
const ENTITY_TARGET_FLAG = /^(?:id|[a-z0-9_-]*id|key|[a-z0-9_-]*key)$/i;
const CONTEXT_TARGET_FLAGS = new Set(["accountid", "calendarid", "folderid", "orgid", "organizationid", "parentid", "projectid", "teamid", "tenantid", "userid", "workspaceid"]);
const NATURAL_TARGET_FLAGS = new Set(["date", "email", "name", "number", "phone", "slug", "start", "startdate", "starttime", "subject", "summary", "title", "to", "url", "username"]);

function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index))
    .map(rest => [value, ...rest]));
}

// Generate narrow command globs for an already-successful change. The ai-agent
// policy is applied to each new retry call, so its exact-command denial also
// covers the same target when cosmetic fields or flag order have changed.
export function changeDenyPatterns(command) {
  let argv = commandWords(command);
  if (!argv) return [];
  if (argv[0] === "aux4") argv = argv.slice(1);
  const firstFlag = argv.findIndex(arg => arg.startsWith("--"));
  const commandPath = (firstFlag < 0 ? argv : argv.slice(0, firstFlag)).join(" ").trim();
  if (!commandPath || !CHANGE_VERB.test(commandPath)) return [];

  const flags = new Map();
  for (let i = Math.max(0, firstFlag); i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    const spelling = equals < 0 ? token.slice(2) : token.slice(2, equals);
    const key = spelling.toLowerCase();
    let value = equals < 0 ? "true" : token.slice(equals + 1);
    if (equals < 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
    const entry = flags.get(key) || { values: [], spellings: new Set() };
    entry.values.push(value);
    entry.spellings.add(spelling);
    flags.set(key, entry);
  }

  const entityIds = [...flags].filter(([key]) => ENTITY_TARGET_FLAG.test(key) && !CONTEXT_TARGET_FLAGS.has(key));
  const naturalKeys = [...flags].filter(([key]) => NATURAL_TARGET_FLAGS.has(key));
  const targetFields = entityIds.length ? entityIds : naturalKeys;
  if (!targetFields.length || targetFields.length > 3 || targetFields.some(([, entry]) => entry.values.length !== 1)) return [];

  const optionsByField = targetFields.map(([key, entry]) => {
    const value = entry.values[0];
    // These values are inserted into a glob. A value containing glob or regex
    // metacharacters could broaden the deny beyond this one target.
    if (!value || /[*?\[\]\\'"\n\r]/.test(value)) return [];
    const forms = /\s/.test(value) ? [`"${value}"`, `'${value}'`] : [value, `"${value}"`, `'${value}'`];
    // Preserve the option spelling the successful call used (for camelCase
    // flags such as --eventId), and include its lowercase form so cosmetic
    // case changes cannot evade the target guard.
    const spellings = [...new Set([...entry.spellings, key])];
    return spellings.flatMap(spelling => forms.map(form => `--${spelling}*${form}*`));
  });
  if (optionsByField.some(forms => !forms.length)) return [];

  const combine = (fields, index = 0, prefix = "") => {
    if (index === fields.length) return [prefix];
    return fields[index].flatMap(fieldPattern => combine(fields, index + 1, prefix + fieldPattern));
  };
  const patterns = [];
  for (const order of permutations(optionsByField)) {
    for (const middle of combine(order)) {
      const base = `${commandPath} *${middle}*`;
      patterns.push(base, `aux4 ${base}`);
    }
  }
  return [...new Set(patterns)];
}

// An allowlist, not a denylist: a command is re-run only when one of its
// command words (before the first flag) is a read verb and none is a change
// verb. A change verb nobody listed then simply means "not re-run".
const READ_VERB = new Set(["get", "list", "show", "view", "read", "find", "search", "describe", "fetch", "status", "count", "info", "inspect", "query", "freebusy", "ls", "cat"]);

export function isReadCommand(command) {
  if (!command || isChangeCommand(command)) return false;
  return commandPathWords(command).some(word => READ_VERB.has(word));
}

const EXECUTION_VALUE_FLAGS = new Set(["--command", "--execute", "--run", "--then"]);

function commandPathWords(command) {
  const parsed = commandWords(command);
  if (!parsed?.length) return [];
  const words = parsed[0] === "aux4" ? parsed.slice(1) : parsed;
  const firstFlag = words.findIndex(word => word.startsWith("-"));
  const path = firstFlag < 0 ? words : words.slice(0, firstFlag);
  const embeddedActions = [];
  for (let i = Math.max(firstFlag, 0); i < words.length; i++) {
    const token = words[i];
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (!EXECUTION_VALUE_FLAGS.has(flag)) continue;
    const value = equals < 0 ? words[++i] : token.slice(equals + 1);
    embeddedActions.push(...(commandWords(value || "") || []));
  }
  return [...path, ...embeddedActions].map(word => word.toLowerCase());
}

export function isChangeCommand(command) {
  return CHANGE_VERB.test(commandPathWords(command).join(" "));
}

export function isSafeReadBack(command, candidates) {
  return Boolean(command) && candidates.includes(command) && isReadCommand(command);
}

// Picks, without a model call, which already-successful read command to
// re-run: the one sharing the most words with the state criteria (latest wins
// a tie). A model picking from a list looped for minutes on a 26B, so this is
// plain word overlap. No overlap means no read can show the state.
function words(text) {
  return new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).map(w => w.replace(/s$/, "")));
}

export function pickReadBack(plan, candidates) {
  const reads = candidates.filter(isReadCommand);
  const target = words((plan.stateCriteria || []).join(" "));
  let best = "";
  let bestScore = 0;
  reads.forEach(c => {
    let score = 0;
    for (const w of words(c)) if (target.has(w)) score++;
    if (score > 0 && score >= bestScore) {
      best = c;
      bestScore = score;
    }
  });
  return { command: best, none: !best };
}

// Small models rarely copy a long command back exactly; a number is easy.
export function pickFromReply(reply, reads) {
  const text = String(reply || "").trim();
  const quoted = [...reads].sort((a, b) => b.length - a.length).find(c => text.includes(c));
  if (quoted) return quoted;
  const n = Number((text.match(/\d+/) || [])[0]);
  return Number.isInteger(n) && n >= 1 && n <= reads.length ? reads[n - 1] : "";
}

// The command stored on an attempt is the executeAux4 tool's own argument --
// "google calendar events list ..." -- never prefixed with the binary name,
// because that is also how policy deny patterns match it (see mergeDenyPolicy).
// Running it directly with the shell therefore needs the same binary runAux4
// uses (respecting AUX4_BIN) put back in front of it; without that, the shell
// tries to run "google" (or "agent", ...) itself and fails every time, which
// is why the read-back silently never produced a check.
// Splits a command the way aux4/ai-agent's executeAux4 does (no shell): '...' is
// literal, "..." allows \" and \\ escapes, an unquoted backslash escapes the next
// character, nothing is ever expanded. Returns null for an unterminated quote.
export function commandWords(command) {
  const words = [];
  let word = null;
  let quote = null;
  const text = String(command || "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else word += ch;
    } else if (quote === '"') {
      if (ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) { word += text[++i]; }
      else if (ch === '"') quote = null;
      else word += ch;
    } else if (/\s/.test(ch)) {
      if (word !== null) { words.push(word); word = null; }
    } else {
      if (word === null) word = "";
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "\\" && i + 1 < text.length) word += text[++i];
      else word += ch;
    }
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

export function runReadBack(command) {
  const bin = process.env.AUX4_BIN || "aux4";
  const words = commandWords(command);
  if (!words || words.length === 0) return { ok: false, output: "invalid command" };
  const result = spawnSync(bin, words, { encoding: "utf8", env: process.env, timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
  const out = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  return { ok: result.status === 0, output: out.slice(0, RESULT_LIMIT * 2) };
}

export function verifyHistoryPath(historyFile, attempt) {
  if (!historyFile) return "";
  const base = historyFile.endsWith(".json") ? historyFile.slice(0, -5) : historyFile;
  return `${base}.verify-${attempt}.json`;
}

// Recovers whole verdict entries from a reply that was cut off mid-JSON (a
// long reply can hit the model's output limit). Entries that were never
// reached stay unreported, which normalizeVerdict turns into unverifiable.
export function salvageVerdict(text) {
  const results = [];
  const entry = /"criterion"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"status"\s*:\s*"(pass|fail|unverifiable)"(?:\s*,\s*"evidence"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;
  let m;
  while ((m = entry.exec(String(text || ""))) !== null) {
    const unescape = v => { try { return JSON.parse(`"${v}"`); } catch { return v; } };
    results.push({ criterion: unescape(m[1]), status: m[2], evidence: m[3] ? unescape(m[3]) : "" });
  }
  return results.length ? { results } : null;
}

// Only state criteria need tools; a verify with none binds a single small
// tool so it is one short call.

export function readVerdict(text) {
  const loose = parseJSONLoose(text, null);
  return Array.isArray(loose?.results) ? loose : salvageVerdict(text);
}

// --- Provenance -----------------------------------------------------------

// A raw "Label=value" string becomes an entered value unless it's the
// confirmation decision itself -- shared by
// enteredValues (parsed from a full command string) and unsourcedFieldValues
// (parsed from the pending call's own --field values, before it has run).
function parseFieldEntry(raw) {
  if (raw && typeof raw === "object" && typeof raw.label === "string" && typeof raw.value === "string") {
    return raw.value ? {label:raw.label || "Unnamed field",value:raw.value} : null;
  }
  const text = String(raw || "");
  const i = text.indexOf("=");
  if (i <= 0) return null;
  const label = text.slice(0, i).trim();
  const value = text.slice(i + 1).trim();
  if (!value || /^confirm$/i.test(label)) return null;
  return { label, value };
}

// A template placeholder copied verbatim ("<value>", "<Label>") is never a real
// value. It is rejected by its shape: its words ("value") usually appear in the
// very output that offered the template, so a word check alone would pass it.
export function isPlaceholder(value) {
  return /^<[^<>]*>$/.test(String(value || "").trim());
}

// Values the agent put into a form or a message: every `--field "Label=value"`
// of a call (the confirmation flag is a decision, not a value).
export function enteredValues(command) {
  const out = [];
  const re = /--field\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;
  let m;
  while ((m = re.exec(String(command || ""))) !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    const entry = parseFieldEntry(raw);
    if (entry) out.push(entry);
  }
  // Values passed as --data JSON are entered values too.
  const dataRe = /--data\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g;
  while ((m = dataRe.exec(String(command || ""))) !== null) {
    const raw = m[1] ?? (m[2] ? m[2].replace(/\\(["\\])/g, "$1") : "");
    for (const entry of dataEntries(raw)) out.push(entry);
  }
  return out;
}

// The "label=value" form of each scalar in a --data JSON object (nested keys joined
// with "."). Unparseable data yields nothing; it is the tool's to reject.
export function dataEntries(raw) {
  let value;
  try { value = JSON.parse(String(raw || "")); } catch { return []; }
  const out = [];
  const walk = (v, prefix) => {
    if (v === null || v === undefined) return;
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, prefix ? `${prefix}.${k}` : k);
      return;
    }
    const entry = parseFieldEntry(`${prefix}=${v}`);
    if (entry) out.push(entry);
  };
  if (value && typeof value === "object") walk(value, "");
  return out;
}

// Whether a call confirms something: confirm=yes as a --field, or "confirm": "yes"
// (any casing, also true) inside --data JSON.
export function confirmsAction(command) {
  const text = String(command || "");
  if (/--field\s+['"]?\s*confirm\s*=\s*yes\b/i.test(text)) return true;
  const dataRe = /--data\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g;
  let m;
  while ((m = dataRe.exec(text)) !== null) {
    let value;
    try { value = JSON.parse(m[1] ?? (m[2] || "").replace(/\\(["\\])/g, "$1")); } catch { continue; }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (/^confirm$/i.test(k) && (v === true || /^yes$/i.test(String(v)))) return true;
      }
    }
  }
  return false;
}

function tokens(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Words a value may be sourced from. A URL's scheme, host and port ("http",
// "127", "0", "1", "7400" in http://127.0.0.1:7400/x) are an address, never data
// the person gave, so they are left out; its path and query stay (an id in a link
// is real data).
export function sourceTokens(text) {
  const withoutAuthorities = String(text || "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\/\s"'<>)\]]+/gi, " ")
    .replace(/\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/gi, " ");
  return tokens(withoutAuthorities);
}

function emailAddresses(text) {
  return String(text || "").match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gi) || [];
}

// Routing addresses are identifiers, so combining words from unrelated facts
// cannot establish one. Require an exact address from the request or a
// successful read; documentation and earlier write echoes are not sources.
export function unsourcedRecipientValues(command, attempts = [], request = "", commandHelp = "") {
  if (!isChangeCommand(command) || /(?:^|\s)--help(?:\s|$)/.test(command)) return [];
  const words = commandWords(command) || [];
  const recipients = [];
  for (let i = 0; i < words.length; i++) {
    const match = words[i].match(/^--(to|cc|bcc|recipient|recipients|email)(?:=(.*))?$/i);
    if (!match) continue;
    const value = match[2] ?? words[++i] ?? "";
    const addresses = emailAddresses(value);
    const sections = String(commandHelp).split(/(?=^  --)/m);
    const parameterHelp = sections.find(section => section.startsWith(`  --${match[1]}`) &&
      new RegExp(`^  --${match[1]}(?:[ =\\s]|$)`, "i").test(section)) || "";
    // A person's name can identify the intended contact, but it is not the
    // email address required by a typed command parameter.
    if (!addresses.length && /\be-?mail\b/i.test(parameterHelp)) {
      recipients.push({ label: match[1], value, invalidFormat: true });
    }
    for (const address of addresses) recipients.push({ label: match[1], value: address });
  }
  const sources = [request, ...attempts.filter(a =>
    a.completed !== false && !a.failed && isReadCommand(a.command) && !/(?:^|\s)--help(?:\s|$)/.test(a.command)
  ).map(a => a.source ?? a.result ?? "")];
  const known = new Set(sources.flatMap(emailAddresses).map(address => address.toLowerCase()));
  return recipients.filter(({ value, invalidFormat }) => invalidFormat || !known.has(value.toLowerCase()));
}

// A value is sourced when every word and number in it appears in the request or
// in a result the agent had already received -- "1990-03-14" from "14/03/1990"
// is; a "12345" that appears nowhere is not. Made-up values are the one thing
// the verifier cannot judge from the answer, so the harness checks them itself.
export function unsourcedValues(attempts, request = "") {
  const found = [];
  const prior = [];
  for (const attempt of attempts) {
    if (!attempt.failed && attempt.completed !== false) {
      found.push(...unsourcedRecipientValues(attempt.command, prior, request));
      const fields = enteredValues(attempt.command).map(({label,value}) => `${label}=${value}`);
      found.push(...unsourcedFieldValues(fields, prior, request).map(entry => ({...entry, command: attempt.command})));
    }
    prior.push(attempt);
  }
  return found;
}

// Tool metadata lists possibilities; it does not establish a value assigned
// to a record. Browser page overviews are context, while fact lookups expose
// their answer/matches separately.
export function fieldEvidenceText(value, command = "") {
  const words=commandWords(command) || [];
  const flag=words.findIndex(word=>word.startsWith("--"));
  const producer=(flag<0?words:words.slice(0,flag)).filter((word,index)=>index!==0 || word!=="aux4").join(" ");
  if (producer === "agent ask" || producer === "ai agent ask") return "";
  const text = String(value ?? "");
  const data = parseJSONLoose(text, null);
  if (!data || typeof data !== "object") return /^[\s]*[\[{]/.test(text) ? "" : text;
  if (data.observations && typeof data.status === "string") return JSON.stringify({pageUrl:data.finalUrl || data.url || ""});
  if (Object.hasOwn(data, "answered")) {
    if (data.answered !== true) return "";
    return JSON.stringify({answer:data.answer, matches:data.matches});
  }
  const clean = item => Array.isArray(item) ? item.map(clean) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([key]) => !/^(?:options|choices|fromGoal|commandReference|documentation|examples)$/i.test(key)).map(([key,v])=>[key,clean(v)])) : item;
  return JSON.stringify(clean(data));
}

export function availableFieldChoices(attempts) {
  const choices=[];
  const walk=(value,label="",possible=false)=>{
    if(Array.isArray(value)){for(const entry of value)walk(entry,label,possible);return;}
    if(value && typeof value==='object'){
      for(const [key,entry] of Object.entries(value))walk(entry,possible && !Array.isArray(value) ? key : label,possible || /^(?:options|choices)$/i.test(key));
    }else if(possible && typeof value==='string')choices.push({label,value});
  };
  for(const attempt of attempts.filter(a=>!a.failed && a.completed!==false && !/(?:^|\s)--help(?:\s|$)/.test(a.command||""))) {
    const data=parseJSONLoose(attempt.source??attempt.result??"",null);
    walk(data);
    for(const text of Object.values(data?.observations || {}).filter(value=>typeof value==="string")) {
      for(const line of text.split(/[|\n]/)) {
        const hint=line.match(/^\s*([^()]+?)\s*\(([^)]+)\)/);
        if(!hint || !/(?:,|\bor\b)/i.test(hint[2]))continue;
        const list=hint[2].split(/--|—/)[0];
        for(const value of list.split(/,|\bor\b/i).map(value=>value.trim()).filter(Boolean))choices.push({label:hint[1].trim(),value,hint:true});
      }
    }
  }
  return choices;
}

export function explicitOpenChoice(label,value,attempts,request) {
  return /\b(?:choose|select|pick)\b[^.!?]*\b(?:any|suitable|appropriate|available)\b/i.test(request)
    && labelNamedIn(label,new Set(sourceTokens(request)))
    && availableFieldChoices(attempts).some(choice=>!choice.hint && choice.value.toLowerCase()===String(value).toLowerCase() && (!choice.label || labelNamedIn(label,new Set(sourceTokens(choice.label)))));
}

// Explicit preservation is a write constraint even when the proposed value
// appears elsewhere in the request (for example, a shortened identity name).
// Only compare unambiguous structured facts; selection among multiple records
// remains part of the action-scope check.
function changesPreservedField(entry, attempts, request) {
  const clauses = [...request.matchAll(/\b(?:preserve|retain)\b([^.!?;]*)|\b(?:keep|leave|maintain)\b([^.!?;]*(?:unchanged|as is|intact|the same))[^.!?;]*/gi)];
  if (!clauses.some(match => labelNamedIn(entry.label, new Set(sourceTokens(match[1] || match[2]))))) return false;
  const observed=observedFieldValue(entry.label,attempts);
  return observed!==null && observed!==entry.value;
}

export function observedFieldValue(labelText, attempts) {
  const keyOf = text => String(text).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const label = keyOf(labelText);
  for (const attempt of [...attempts].reverse()) {
    if (attempt.failed || attempt.completed === false || enteredValues(attempt.command).length || /(?:^|\s)(?:--help|-h)(?:\s|$)/.test(attempt.command || "")) continue;
    const values = new Set();
    const walk = item => {
      if (!item || typeof item !== "object") return;
      for (const [key, value] of Object.entries(item)) {
        if (keyOf(key) === label && value !== null && typeof value !== "object") values.add(String(value));
        else if (typeof value === "object") walk(value);
      }
    };
    walk(parseJSONLoose(fieldEvidenceText(attempt.source ?? attempt.result, attempt.command), null));
    if (values.size === 1) return [...values][0];
    if (values.size > 1) return null;
  }
  return null;
}

// Enforce unambiguous explicit boolean directions before model judgment.
// Ambiguous/mixed directives retain normal semantic scope verification.
function explicitChoiceDirection(label, request) {
  const expected = new Set();
  for (const clause of String(request).split(/[.!?;\n]/)) {
    const directives = [...clause.matchAll(/\b(enable|disable|activate|deactivate|subscribe|unsubscribe|check|uncheck|turn\s+on|turn\s+off|opt\s+in|opt\s+out)\b/gi)];
    for (let i=0;i<directives.length;i++) {
      const directive=directives[i];
      const segment=directives.length===1 ? clause : clause.slice(directive.index,directives[i+1]?.index || clause.length);
      if (!labelNamedIn(label,new Set(sourceTokens(segment)))) continue;
      let enabled=/^(?:enable|activate|subscribe|check|turn\s+on|opt\s+in)$/i.test(directive[0]);
      if (/(?:\bdo\s+not|\bdon't|\bnever|\bnot)\s*$/i.test(clause.slice(0,directive.index))) enabled=!enabled;
      if (/^\s*(?:disable|unsubscribe|uncheck|no\b|not\b|don't\b|do not\b|opt[ -]?out)/i.test(label)) enabled=!enabled;
      expected.add(enabled);
    }
  }
  return expected.size===1 ? [...expected][0] : null;
}

// Same provenance check as unsourcedValues, but for a call that has NOT run
// yet -- the hooks path (see "Hooks integration" below) checks the pending
// confirmation's own --field values against everything that happened before
// it, instead of re-parsing it out of a finished attempt log.
export function unsourcedFieldValues(fields, attempts, request = "") {
  const requestTokens = new Set(sourceTokens(request));
  const found = [];
  for (const raw of fields || []) {
    const entry = parseFieldEntry(raw);
    if (!entry) continue;
    if (changesPreservedField(entry, attempts, request)) {
      found.push({...entry, preserved: true});
      continue;
    }
    // A call that entered this value echoes it back in its own result; that
    // echo is not a source (it would make any made-up value look sourced).
    const seen = new Set(requestTokens);
    for (const attempt of attempts) {
      if (attempt.failed || attempt.completed === false || /(?:^|\s)(?:--help|-h)(?:\s|$)/.test(attempt.command || "")) continue;
      if (enteredValues(attempt.command).some(e => e.value === entry.value)) continue;
      const observed = parseJSONLoose(attempt.source ?? attempt.result ?? "", null);
      if (Object.values(observed?.fromGoal || {}).some(value => value === entry.value)) continue;
      for (const t of sourceTokens(fieldEvidenceText(attempt.source ?? attempt.result,attempt.command))) seen.add(t);
    }
    // A yes/no answer for a choice the request itself names ("subscribe to
    // product updates" -> Subscribe=yes) states the request's intent, not data.
    if (isChoiceAnswer(entry.value) && labelNamedIn(entry.label, requestTokens)) {
      const direction=explicitChoiceDirection(entry.label,request);
      const selected=/^(yes|true|on|checked|y)$/i.test(entry.value.trim());
      if (direction!==null && direction!==selected) found.push({...entry,directionMismatch:true});
      continue;
    }
    if (explicitOpenChoice(entry.label,entry.value,attempts,request)) continue;
    const missing = tokens(entry.value).filter(t => !seen.has(t));
    if (isPlaceholder(entry.value) || missing.length) found.push(entry);
  }
  return found;
}

const CHOICE_ANSWER = /^(yes|no|true|false|on|off|checked|unchecked|y|n)$/i;
function isChoiceAnswer(value) {
  return CHOICE_ANSWER.test(String(value || "").trim());
}
// Most of the label's own words (ignoring hints in brackets) appear in the request.
// English word matching; this share is the only gate on accepting a yes/no answer.
const LABEL_NAMED_SHARE = 0.6;
function labelNamedIn(label, requestTokens) {
  const words = tokens(String(label || "").replace(/\([^)]*\)/g, " ")).filter(w => w.length > 2);
  if (words.length === 0) return false;
  const hits = words.filter(w => requestTokens.has(w)).length;
  return hits / words.length >= LABEL_NAMED_SHARE;
}

// --- Confirmation gate ---------------------------------------------------
// Anything that cannot be undone goes through a confirmation call (agent/browser
// stops before it and offers `--field 'confirm=yes'`). The harness cannot see a
// call while a round runs, so it holds every confirmation for one round: the
// confirmation is denied, the harness checks where every entered value came
// from, and only then lets the agent run it -- a made-up value never reaches
// the page.
export const CONFIRM_PATTERN = "*confirm=yes*";
// The same confirmation passed as --data JSON ({"confirm":"yes"}).
export const CONFIRM_DATA_PATTERN = "*\"confirm\"*";
export const CONFIRM_NOTE = "Anything that cannot be undone is confirmed in two steps: when you run a confirmation (confirm=yes), it is held while the values you entered are checked, and then you are told to run it again. Do not try another way around it.";

export function heldConfirmation(attempts) {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (/confirm=yes/.test(a.command || "") && /policy denie|denied_action/i.test(a.result || "")) return { index: i, command: a.command };
  }
  return null;
}

export function composeConfirmQuestion(command) {
  const call = String(command || "").replace(/^executeAux4\s*/, "");
  return [
    "The values you entered were checked: each one comes from the request or from a tool result.",
    `Run the confirmation now, exactly as before: ${call}`,
    "Then report what it did."
  ].join("\n");
}

export function composeNotConfirmedQuestion(unsourced) {
  const lines = unsourced.map(u => `- "${u.label}" = "${u.value}" appears neither in the request nor in any tool result`);
  return [
    "This call was NOT run, because these values did not come from anywhere:",
    ...lines,
    "",
    "Never make up a value. If you can find the real value with the tools, use it. Otherwise do not type or submit it: reply saying exactly which value is missing, and stop."
  ].join("\n");
}

export const PROVENANCE_CRITERION = "every value entered or sent came from the request or a tool result";

function observedChange(attempt) {
  if (attempt.failed || attempt.completed === false || !isChangeCommand(attempt.command)) return false;
  return isConclusiveAttempt(attempt) || parseJSONLoose(attempt.source ?? attempt.result ?? "", null)?.submitted === true;
}

function parseAttemptResult(attempt) {
  try { return JSON.parse(String(attempt?.source ?? attempt?.result ?? "")); }
  catch { return null; }
}

function goalNotVerified(result) {
  return result?.goalVerified === false || result?.scopedOperation?.goalVerified === false;
}

function hasFreshObservation(result) {
  return typeof result?.observations?.current === "string" && result.observations.current.trim().length > 0;
}

// Recognize source envelopes rather than recursively treating arbitrary API
// record fields named "partial" or "truncated" as transport metadata.
function hasExplicitIncompleteSourceMetadata(value) {
  if (!value || typeof value !== "object") return false;
  const inspectEnvelope = Object.hasOwn(value, "completeWithinScope") || Object.hasOwn(value, "extractionContract")
    || Object.hasOwn(value, "truncatedBlockCount") || Object.hasOwn(value, "truncatedControls");
  if (inspectEnvelope) {
    if (value.completeWithinScope === false || value.truncated === true
      || Number(value.truncatedBlockCount || 0) > 0 || Number(value.truncatedControls || 0) > 0
      || (typeof value.coverage === "string" && /^(partial|truncated|ranked|unknown)(?:-|$)/i.test(value.coverage))
      || (Array.isArray(value.blocks) && value.blocks.some(block => block?.truncated === true))) return true;
  }
  const metadata = value.sourceMetadata;
  if (metadata && typeof metadata === "object"
    && (metadata.partial === true || metadata.truncated === true || metadata.ranked === true
      || /^(partial|truncated|ranked|unknown)(?:-|$)/i.test(String(metadata.coverage || "")))) return true;
  const rankedFindEnvelope = Array.isArray(value.matches) && typeof value.provider === "string"
    && Object.hasOwn(value, "answered") && Object.hasOwn(value, "question");
  if (rankedFindEnvelope) return true;
  const rankedEnvelope = (Array.isArray(value.matches) || Array.isArray(value.blocks))
    && (Object.hasOwn(value, "provider") || Object.hasOwn(value, "answered") || Object.hasOwn(value, "candidates"));
  return rankedEnvelope && (value.matches || value.blocks || []).some(item => typeof item?.score === "number");
}

export function executionProofContent(content, verdict, attempts) {
  if (!verdict?.executionEvidenceMissing || attempts.some(observedChange)) return content;
  return "The requested change was not completed. The recorded attempts to change state failed, were denied, or remained unexecuted.";
}

// State-changing outcomes cannot be confirmed solely from failed or
// unexecuted writes. Read-only/absence criteria and already-satisfied tasks
// with no failed write attempt retain their normal verification.
export function applyExecutionProof(verdict, plan, attempts, currentState = null) {
  const state = new Set(plan.stateCriteria || []);
  const changeState = new Set([...state].filter(text => !NO_CHANGE_CRITERION.test(text) && !/^\s*(?:no|none|nothing|without)\b/i.test(text)
    && (CHANGE_VERB.test(text) || CHANGE_RESULT_WORD.test(text))));
  if (!state.size) return verdict;
  let changed = false;
  const criteria = verdict.criteria.map(criterion => {
    if (!state.has(criterion.criterion)) return criterion;
    let next = criterion;
    if (criterion.relation === "contradicts") {
      next = { ...next, status: "fail", evidence: criterion.evidence || "A supplied current fact contradicts this outcome." };
    } else if (criterion.relation === "unknown") {
      next = { ...next, status: "unverifiable", evidence: criterion.evidence || "The supplied facts do not establish this outcome." };
    }
    if (criterion.basis === "answer" && criterion.relation !== "contradicts" && criterion.status === "pass") {
      next = { ...next, status: "unverifiable", evidence: criterion.evidence || "An answer alone cannot establish current state." };
    }
    if (criterion.claim === "absence" && criterion.relation === "supports" && criterion.coverage !== "complete") {
      next = { ...next, status: "unverifiable", evidence: criterion.evidence || "Coverage is not complete for this absence claim." };
    }
    let source = null;
    if (criterion.basis === "currentState" && (currentState?.source || currentState?.output)) {
      try { source = JSON.parse(String(currentState.source || currentState.output)); } catch { source = null; }
    } else if (criterion.basis === "actionResult") {
      source = attempts.map(parseAttemptResult).find(result => result && hasExplicitIncompleteSourceMetadata(result));
    }
    if (criterion.claim === "absence" && criterion.relation === "supports" && hasExplicitIncompleteSourceMetadata(source)) {
      next = { ...next, status: "unverifiable", evidence: criterion.evidence || "Structured source metadata marks this result partial, truncated, or ranked." };
    }
    if (criterion.basis === "currentState" && criterion.status === "pass" && goalNotVerified(source) && !hasFreshObservation(source)) {
      next = { ...next, status: "unverifiable", evidence: criterion.evidence || "The operation receipt has no fresh current observation." };
    }
    if (criterion.basis === "actionResult" && criterion.relation === "supports" && criterion.status === "pass"
      && attempts.some(a => goalNotVerified(parseAttemptResult(a)))) {
      next = { ...next, status: "unverifiable", evidence: criterion.evidence || "The operation receipt says its goal was not verified." };
    }
    // Contradiction has precedence over any other typed annotation.
    if (criterion.relation === "contradicts") {
      next = { ...next, status: "fail", evidence: criterion.evidence || "A supplied current fact contradicts this outcome." };
    }
    if (next !== criterion) changed = true;
    return next;
  });
  const missingWriteProof = changeState.size > 0 && attempts.some(a => !isConclusiveAttempt(a) && isChangeCommand(a.command)) && !attempts.some(observedChange);
  if (!changed && !missingWriteProof) return verdict;
  if (missingWriteProof) {
    return { ...verdict, overall: "fail", executionEvidenceMissing: true, criteria: criteria.map(criterion => changeState.has(criterion.criterion) && criterion.status === "pass"
      ? { ...criterion, status: "unverifiable", evidence: "No successful state-changing action was observed. Failed, denied, or unexecuted calls cannot establish that the requested change happened." }
      : criterion) };
  }
  return { ...verdict, overall: criteria.every(c => c.status === "pass") ? "pass" : "fail", criteria };
}

export function applyProvenance(verdict, attempts, request = "") {
  const unsourced = unsourcedValues(attempts, request);
  if (!unsourced.length) return verdict;
  const evidence = unsourced.map(u => `"${u.label}" = "${u.value}" appears neither in the request nor in any tool result before it was used`).join("; ");
  return {
    ...verdict,
    overall: "fail",
    criteria: [...verdict.criteria, { criterion: PROVENANCE_CRITERION, status: "fail", evidence: `${evidence}. A value that cannot be found must not be made up: say it is missing.` }]
  };
}

// --- Same-round confirmation (HARN-035 / HARN-038) -------------------------
// The browser tool emits a structured confirmation contract. Parse that
// object directly; reason prose and top-level next text are display fields,
// not a protocol between packages.
function jsonObjectField(text, field) {
  const match = String(text || "").match(new RegExp('"' + field + '"\\s*:\\s*\\{'));
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(open, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function readConfirmationContract(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const parsed = parseJSONLoose(text, null);
  const contract = parsed?.confirmation && typeof parsed.confirmation === "object"
    ? parsed.confirmation
    : jsonObjectField(text, "confirmation");
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return null;
  const action = typeof contract.action === "string" ? contract.action.trim() : "";
  const target = typeof contract.target === "string" ? contract.target.trim() : "";
  const next = typeof contract.next === "string" ? contract.next.trim() : "";
  if (!action || !target || !next || !confirmsAction(next) || !Array.isArray(contract.emptyFields)) return null;
  return { action, target, next, emptyFields: contract.emptyFields.map(String) };
}

export function hasConfirmationContract(value) {
  return readConfirmationContract(value) !== null;
}

// Return an unresolved structured confirmation from this round. A later blocked
// confirm=yes call does not make the earlier pending confirmation disappear.
export function pendingConfirmation(attempts) {
  const last = attempts[attempts.length - 1];
  if (!last) return null;
  const readPending = attempt => {
    if (!attempt || attempt.failed) return null;
    const text = String(attempt.source ?? attempt.result ?? attempt.resultSummary ?? "");
    const contract = readConfirmationContract(text);
    if (!contract) return null;
    const parsed = parseJSONLoose(text, null);
    const reason = typeof parsed?.reason === "string"
      ? parsed.reason
      : 'The action "' + contract.action + '" for "' + contract.target + '" needs confirmation.';
    return {
      command: attempt.command,
      next: contract.next,
      reason,
      label: contract.action,
      target: contract.target,
      emptyFields: contract.emptyFields
    };
  };
  const current = readPending(last);
  if (current) return current;
  // A short model may retry confirm=yes after the browser tool already returned
  // a structured pending contract. If each later confirmation call was blocked,
  // recover that still-pending contract instead of letting the retry hide it.
  if (!last.failed || !confirmsAction(last.command || "")) return null;
  for (let i = attempts.length - 2; i >= 0; i--) {
    const prior = attempts[i];
    if (prior.failed && confirmsAction(prior.command || "")) continue;
    return readPending(prior);
  }
  return null;
}

// "Clearly requested" is kept strict on purpose: the request's OWN words must
// contain the same change verb as the pending action's label (reusing
// CHANGE_VERB, the same classifier the rest of the loop uses for a change).
// Anything short of that -- the request says nothing about it, or only an
// unrelated action -- is NOT clearly requested: an ambiguous case must ask,
// exactly like one that is clearly beyond the request, never run on a guess.
// A rough English stem so "book"/"booking"/"booked", "confirm"/"confirming",
// "save"/"saving", "cancel"/"cancelled" compare equal.
export function wordStem(word) {
  let w = String(word || "").toLowerCase();
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  }
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

// Strict: the action's own verb -- the label's first word, or any change verb in
// it -- must appear (in any form) in the request itself, AND when the label names
// what it acts on ("Cancel order", "Delete account"), that object must appear in
// the request too. A shared verb with a different object ("cancel my newsletter"
// vs "Cancel order #123") is not a request for this action: ask instead.
const LABEL_STOPWORDS = new Set(["the", "this", "that", "your", "my", "and", "for", "now", "all", "form", "page", "item"]);
export function isClearlyRequestedAction(label, request) {
  const labelWords = String(label || "").match(/[A-Za-z]+/g) || [];
  if (labelWords.length === 0) return false;
  const verbs = new Set([wordStem(labelWords[0])]);
  for (const w of labelWords) if (CHANGE_VERB.test(w)) verbs.add(wordStem(w));
  const requestStems = new Set((String(request || "").match(/[A-Za-z]+/g) || []).map(wordStem));
  if (![...verbs].some(v => v.length >= 3 && requestStems.has(v))) return false;
  const objects = labelWords.map(wordStem)
    .filter(w => w.length >= 3 && !verbs.has(w) && !LABEL_STOPWORDS.has(w));
  if (objects.length > 0 && !objects.some(o => requestStems.has(o))) return false;
  // The action names one specific item ("Cancel order ord-0001", "Delete #123"): the
  // request must say which item -- by that identifier, or by details that pick one out
  // (a number, a quoted value, a name). "Cancel my order" picks none: ask.
  const ids = (String(label || "").match(/[A-Za-z0-9#][\w#.-]*/g) || []).filter(t => /\d/.test(t));
  if (ids.length === 0) return true;
  const reqTokens = new Set((String(request || "").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").toLowerCase().match(/[a-z0-9#][\w#.-]*/g) || [])
    .map(t => t.replace(/[.-]+$/, "")));
  if (ids.some(id => reqTokens.has(id.toLowerCase().replace(/[.-]+$/, "")))) return true;
  return requestSelectsItem(request);
}

// Whether an action names one specific item ("Cancel order ord-0001", "Delete #123")
// that the request does not pick out -- by that identifier or by details. Such an
// action must never be confirmed without asking the person which item they mean.
export function namesUnselectedItem(label, request) {
  const ids = (String(label || "").match(/[A-Za-z0-9#][\w#.-]*/g) || []).filter(t => /\d/.test(t));
  if (ids.length === 0) return false;
  const reqTokens = new Set((String(request || "").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").toLowerCase().match(/[a-z0-9#][\w#.-]*/g) || [])
    .map(t => t.replace(/[.-]+$/, "")));
  if (ids.some(id => reqTokens.has(id.toLowerCase().replace(/[.-]+$/, "")))) return false;
  return !requestSelectsItem(request);
}

// Whether a request picks out a specific item by its own details: a number, a quoted
// value, or a capitalised name -- not counting URLs (a port is not a detail).
export function requestSelectsItem(request) {
  const text = String(request || "").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  if (/\d/.test(text)) return true;
  if (/"[^"]+"|'[^']{2,}'/.test(text)) return true;
  // A capitalised word counts as a name unless it starts a line or a sentence.
  return text.split(/\n+/).some(line => {
    const words = line.replace(/^[\s\-*\d.)]+/, "").split(/\s+/).filter(Boolean);
    return words.some((w, i) => i > 0 && /^[A-Z][a-z]+/.test(w) && !/[.!?:]$/.test(words[i - 1]));
  });
}

export function composeRunNextQuestion(pending) {
  const call = String(pending.next || "").replace(/^executeAux4\s*/, "");
  return [
    "The request asks for this action. Run the next command now, exactly as given:",
    call,
    "Then report what it did."
  ].join("\n");
}

export function composeNeedsConfirmationAnswer(pending) {
  const label = pending.label || "this action";
  const reason = pending.reason ? ` ${pending.reason}` : "";
  return `This needs your confirmation before it runs: ${label}.${reason} Reply to confirm it, and it will be run.`;
}

// --- Hooks integration (HARN-030) -----------------------------------------
// aux4/ai-agent >=1.3.0 can check a tool call BEFORE it runs, inside the round
// (its own `--hooks`, following aux4 core's hook standard). When it's
// available, the provenance check becomes a `before` hook on
// every agent:browser/run call (a made-up value is stopped where it is typed,
// and a confirmation re-checks everything typed before it) instead of the two-round gate above:
// one round, not two, and the model sees the SAME check either way (this
// hook calls `aux4 agent check-values`, which shares unsourcedFieldValues
// with the gate's own unsourcedValues). Capability is detected, never
// assumed, by probing the installed ai-agent's own --help for `--hooks` --
// an older ai-agent silently keeps using the gate.
let hooksSupportCache = null;

export function detectAiAgentHooksSupport() {
  if (hooksSupportCache !== null) return hooksSupportCache;
  try {
    const result = runAux4(["ai", "agent", "ask", "--help"], { allowFailure: true });
    hooksSupportCache = result.ok && /--hooks\b/.test(result.stdout);
  } catch {
    hooksSupportCache = false;
  }
  return hooksSupportCache;
}

// Exposed for tests -- never call from production code outside this module.
export function resetHooksSupportCacheForTests() {
  hooksSupportCache = null;
}

export function checkValuesHooksFile(packageDir, requestFile = "", guardOptionsFile = "") {
  const repeatedReadHook = pattern => ({
    tool: "executeAux4",
    command: pattern,
    timeout: 60000,
    before: [`node ${packageDir}/lib/check-values.mjs --repeatReadGuard true --history value(__history) --command value(__commandLine)${requestFile ? ` --requestFile ${requestFile}` : ""}${guardOptionsFile ? ` --guardOptions ${guardOptionsFile}` : ""}`]
  });
  return {
    hooks: [
      // Installed command paths currently resolve to two or three segments;
      // cover both forms so the loop guard works across package profiles.
      repeatedReadHook("*/*"),
      repeatedReadHook("*/*/*"),
      {
        tool: "executeAux4",
        command: "agent:browser/run",
        before: [
          `node ${packageDir}/lib/check-values.mjs --request value(__request) --history value(__history) --fieldsJson value(field) --dataJson value(data)${requestFile ? ` --requestFile ${requestFile}` : ""}`
        ]
      }
    ]
  };
}

// Written once per run next to the history file so a hook hitting the same
// agent:browser/run call always reads the live history -- never a stale copy.
// The hook judges against the person's ORIGINAL request (written next to the history),
// not the round's composed question, which also carries the harness's own criteria text.
export function writeCheckValuesHooksFile(packageDir, history, request = "", options = null) {
  const file = `${history}.hooks.json`;
  // Absolute: hook steps run from a scratch directory, not the agent's own.
  const ownRequestFile = path.resolve(`${history}.request.txt`);
  fs.writeFileSync(ownRequestFile, String(request || ""));
  const requestFile = options?.authorityRequestFile || ownRequestFile;
  const guardFile = options?.configFile ? path.resolve(`${history}.guard-options.json`) : "";
  if (guardFile) fs.writeFileSync(guardFile, JSON.stringify({
    packageDir: path.resolve(packageDir), configFile: path.resolve(options.configFile), config: options.config || "",
    history: path.resolve(history),
    delegatedPrefixes: (options.delegations || []).map(d => d.via.replace(/:/g, " "))
  }, null, 2));
  fs.writeFileSync(file, JSON.stringify(checkValuesHooksFile(packageDir, requestFile, guardFile), null, 2));
  return file;
}

export function runVerify(options, plan, finalAnswer, attempts, verifyHistory = "") {
  const payload = verifyPayload(plan, finalAnswer, attempts, options.request);
  const readBack = readBackCandidates(attempts);
  const hasState = (plan.stateCriteria || plan.doneCriteria).length > 0;
  // The harness reads the current state itself when it safely can.
  let readNow = null;
  // Only when there are successful actions can their own results be the
  // evidence; with nothing done, a pass can only be trust in the answer.
  const anySuccess = attempts.some(a => !a.failed);
  let noReadPossible = anySuccess && !readBack.some(isReadCommand);
  if (hasState && readBack.length) {
    const pick = pickReadBack(plan, readBack);
    const command = pick.command;
    if (anySuccess && !isSafeReadBack(pick.command, readBack)) noReadPossible = true;
    if (isSafeReadBack(command, readBack)) {
      const r = runReadBack(command);
      if (r.ok) readNow = { command, output: r.output };
    }
  }
  const latestAttempt = attempts.at(-1);
  const sameCallObservation = !readNow && latestAttempt && !latestAttempt.failed && isConclusiveAttempt(latestAttempt) ? (() => {
    const attempt = latestAttempt;
    const result = parseAttemptResult(attempt);
    return goalNotVerified(result) && hasFreshObservation(result) ? attempt : null;
  })() : null;
  const currentState = readNow || (sameCallObservation
    ? {
      command: sameCallObservation.command,
      output: JSON.stringify({ observations: { current: parseAttemptResult(sameCallObservation).observations.current } }),
      source: String(sameCallObservation.source ?? sameCallObservation.result ?? "")
    }
    : null);
  if (currentState) payload.currentState = sameCallObservation
    ? { observedWith: "same-call observations.current", command: currentState.command, result: currentState.output }
    : { readJustNowWith: currentState.command, result: currentState.output };
  const stateFirst = hasState && currentState
    ? "Judge the state criteria from currentState, which was read just now, after the work. Then "
    : hasState ? "No later read can show the current state, so judge the state criteria from the actions' own results. Then " : "";
  const question = `${stateFirst}${stateFirst ? "r" : "R"}espond with ONLY the JSON verdict object described in your instructions.\n\n${JSON.stringify(payload)}`;
  if (verifyHistory) fs.rmSync(verifyHistory, { force: true });
  const result = askOnce(options, {
    instructions: verifyInstructionsPath(options.packageDir),
    question,
    history: verifyHistory,
    // The verifier never gets real tools: the harness does the looking.
    extraArgs: ["--tools", PLAN_TOOLS]
  });
  const checks = [
    ...(readNow ? [{ command: readNow.command }] : []),
    ...(verifyHistory ? extractAttemptLog(verifyHistory) : [])
  ];
  // A reply cut off mid-JSON can still contain a complete inner entry, which a
  // loose parse would return on its own; only a parse with results counts.
  let parsed = readVerdict(result.stdout);
  if (!parsed && verifyHistory) {
    // Small models sometimes answer in prose or return nothing; one follow-up
    // in the same conversation (its prefix is cached) usually yields the JSON.
    const again = askOnce(options, {
      instructions: verifyInstructionsPath(options.packageDir),
      question: "Give your verdict now as ONLY the JSON object described in your instructions, one entry per criterion in the given order.",
      history: verifyHistory,
      extraArgs: ["--tools", PLAN_TOOLS]
    });
    parsed = readVerdict(again.stdout);
  }
  const criteria = verifyCriteria(plan);
  const verdict = parsed
    ? normalizeVerdict(parsed, criteria)
    : fallbackVerdict(criteria, "the verifier's output could not be parsed, so this outcome could not be confirmed");
  // Without a history file the verifier's own calls can't be counted, so the
  // own-observation rule only applies when there is one.
  // When nothing can re-read the state (only the action's own result shows
  // it), the verifier's judgement from the recorded results stands.
  const observed = verifyHistory && !noReadPossible && !sameCallObservation
    ? requireOwnObservation(verdict, checks, plan.stateCriteria || plan.doneCriteria, attempts)
    : verdict;
  return { ...applyExecutionProof(applyProvenance(observed, attempts, options.request), plan, attempts, currentState), checks: checks.map(c => c.command) };
}

export function verdictLogPath(historyFile) {
  if (!historyFile) return "";
  return historyFile.endsWith(".json") ? historyFile.slice(0, -5) + ".verify.json" : `${historyFile}.verify.json`;
}

// Every verify round is kept next to the plan, so a run can be diagnosed
// afterwards: what was attempted, what the verifier checked, and why it decided.
export function saveVerdict(historyFile, attempt, attempts, verdict) {
  const file = verdictLogPath(historyFile);
  if (!file) return;
  try {
    const rounds = attempt === 1 ? [] : (parseJSONLoose(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", []) || []);
    rounds.push({ attempt, ms: verdict.ms, actionsAttempted: attempts.map(a => a.command), checks: verdict.checks || [], overall: verdict.overall, criteria: verdict.criteria });
    fs.writeFileSync(file, JSON.stringify(rounds, null, 2));
  } catch {
    // best-effort; the loop still works without a persisted verdict log
  }
}

// --- Diagnose + retry policy ----------------------------------------------

export function extractFailureClass(text) {
  const match = String(text || "").match(/FAILURE_CLASS:\s*([a-z_]+)/i);
  if (!match) return "";
  const value = match[1].toLowerCase();
  return FAILURE_CLASSES.includes(value) ? value : "";
}

// aux4 reports a missing required parameter as "Error to enter the value of
// <name>"; spell out what that means so the retry passes it.
export function missingParameterHints(attempts) {
  const hints = [];
  for (const a of attempts) {
    if (!a.failed) continue;
    const result = String(a.result || a.resultSummary || "");
    const missing = result.match(/Error to enter the value of (\w+)/i);
    if (missing) {
      hints.push(`"${a.command.slice(0, 80)}" was missing the required --${missing[1]} parameter: pass --${missing[1]} with its value.`);
      continue;
    }
    const unsupported = result.match(/(?:unknown|unsupported|unrecognized|unexpected)\s+(?:parameter|option|flag)\s*:?\s*(?:--)?([\w-]+)/i);
    if (unsupported) {
      hints.push(`"${a.command.slice(0, 80)}" rejected --${unsupported[1]} as an unsupported parameter. Read that command's exact --help, remove or replace the rejected option, then continue the remaining steps. Do not retry the rejected option.`);
    }
  }
  return hints.length ? ["", ...[...new Set(hints)]] : [];
}

// Every state criterion holds and only what the answer says is off: fix the
// answer, not the world.
// A rewrite-only retry ("do not run any more actions") is for an answer that
// misstates results it already has. With no successful tool result there is
// nothing to restate: the work was never done, so the retry must act.
// A tool can succeed as a call and still report that its own work is unfinished
// ({"status": "incomplete"}, "needs-input", "error"...). That is not finished work.
const INCONCLUSIVE_STATUS = /"status"\s*:\s*"(incomplete|needs-input|needs-confirmation|error|blocked|failed|no-progress)"/i;
export function isConclusiveAttempt(attempt) {
  const result = String(attempt.source ?? attempt.result ?? "");
  return attempt.completed !== false && !attempt.failed && !INCONCLUSIVE_STATUS.test(result) && !/"submitted"\s*:\s*false\b/i.test(result);
}

const CHANGE_RESULT_WORD = /\b(sent|saved|submitted|booked|confirmed|cancelled|canceled|deleted|removed|archived|updated|patched|posted|created|inserted|added|written|moved|modified|edited|renamed|uploaded|published|deployed|paid|approved|installed|uninstalled|forwarded|replied)\b/i;

export function onlyAnswerFailed(plan, verdict, attempts = null) {
  // Only a rewrite when some action actually finished; a round whose tools all
  // failed or reported unfinished work needs another try at the work itself.
  if (Array.isArray(attempts) && !attempts.some(isConclusiveAttempt)) return false;
  const state = new Set(plan.stateCriteria || plan.doneCriteria);
  const unmet = verdict.criteria.filter(c => c.status !== "pass");
  // If a requested state-changing outcome is marked complete but the verifier
  // found that the answer's account of the actions is unsupported, don't let a
  // rewrite-only round hide a missing write behind that incorrect state pass.
  const changeExpected = (plan.stateCriteria || []).some(c => CHANGE_VERB.test(c) || CHANGE_RESULT_WORD.test(c));
  const actionAccuracyFailed = unmet.some(c => c.criterion === HONESTY_CRITERION);
  if (Array.isArray(attempts) && changeExpected && actionAccuracyFailed &&
      !attempts.some(a => !a.failed && isConclusiveAttempt(a) && isChangeCommand(a.command))) return false;
  return unmet.length > 0 && unmet.every(c => !state.has(c.criterion)) &&
    verdict.criteria.filter(c => state.has(c.criterion)).every(c => c.status === "pass");
}

export function composeRewriteQuestion(verdict) {
  const unmet = verdict.criteria.filter(c => c.status !== "pass").map(c => `- ${c.criterion}: ${c.evidence}`).join("\n");
  return [
    "The work itself is done and confirmed. Only your final answer is off:",
    unmet,
    "",
    "Do not run any more actions. Reply with a corrected final answer that states exactly what was done and what the results showed."
  ].join("\n");
}

function retryReadEvidence(attempts) {
  const unique = new Map();
  for (const attempt of attempts) {
    if (attempt.completed === false || attempt.failed || !isReadCommand(attempt.command)
      || /(?:^|\s)--help(?:\s|$)/.test(attempt.command)) continue;
    const key = readEvidenceKey(attempt);
    if (key) unique.set(key, attempt);
  }
  let remaining = RESULTS_TOTAL_LIMIT;
  const facts = [];
  for (const attempt of [...unique.values()].reverse()) {
    if (remaining <= 0) break;
    const source = String(attempt.source ?? attempt.result ?? "").slice(0, Math.min(1400, remaining));
    remaining -= source.length;
    facts.push(`${attempt.command}\n${source}`);
  }
  return facts.length ? facts.join("\n\n") : "(no successful read evidence yet)";
}

export function composeDiagnoseQuestion(plan, verdict, attempts, request = "", lookFirst = false) {
  const failed = verdict.criteria.filter(c => c.status !== "pass");
  const lines = failed.map(c => `- ${c.criterion} (${c.status}): ${c.evidence}`).join("\n");
  // Small models answer a "classify first" prompt in prose and end the turn,
  // so the retry asks for action, with the failure types only as hints.
  return [
    ...(lookFirst ? [LOOK_BEFORE_ASKING, ""] : []),
    "The previous attempt did not fully achieve the goal.",
    "",
    `Request: ${request || plan.goal}`,
    "",
    "Outcomes not yet confirmed:",
    lines,
    "",
    "Facts already observed from successful reads (reuse these; do not re-read without a state change):",
    retryReadEvidence(attempts),
    "",
    "What was attempted, in order:",
    summarizeAttemptLog(attempts),
    ...(allowedCommandsOffered(attempts) ? ["", `Commands you may run: ${allowedCommandsOffered(attempts)}`] : []),
    ...missingParameterHints(attempts),
    "",
    "Work out why (wrong command, wrong parameters, a tool error, a step not done, a misread fact) and fix it now by calling the tools. Do not just describe the fix -- do it.",
    "Actions listed as FAILED are denied for this retry. Reuse facts from successful reads to complete the unmet outcomes. A successful change may already have taken effect: check its resulting state if needed, and never repeat one that sends, creates, or deletes something.",
    WORKING_RULES,
    "",
    `Only if finishing needs something only the requester can give (and you have already searched the help and any list of commands you may run), reply starting with "${BLOCKED_MARK}" and say exactly what you need.`
  ].join("\n");
}

// How to find what provides each thing a request names. Small models tend to
// guess a command name, get it wrong once, and give up; the help text and any
// list of allowed commands usually name the right one in the request's words.
export const FIND_THE_COMMAND = "To find what provides each thing the request names, match the request's own words against the help descriptions (drill down with --help from the most specific group) and against any list of commands you may run. Prefer a command whose description uses the same words as the request over a guess.";

// A question whose results support a reasonable reading should be answered,
// not bounced back. Asking first is for actions that change something.
export const ANSWER_DONT_ASK = "If part of a question is ambiguous, answer it with the reading the results best support and say which reading you used. Ask the requester only before an action that would change something, never instead of answering.";

// Something sent or removed cannot be taken back, so whatever it depends on
// has to be established first, not assumed.
export const CHECK_BEFORE_IRREVERSIBLE = "Before an action that cannot be undone (sending, deleting, paying), first get the facts it depends on from the tools; if you could not get them, do not take the action -- find another way to get them.";

// A message sent on the requester's behalf is read without this conversation,
// so it has to say what it refers to.
export const MESSAGES_STAND_ALONE = "Anything you send on the requester's behalf must make sense on its own: name the specific thing it answers or refers to (the item, the date and time), not just \"that\".";

// One compact block of working rules, each aimed at a kind of call that buys
// nothing: guessed command or parameter names, repeating a change that already
// worked, retrying what the requester declined, and asking instead of answering.
export const WORKING_RULES = [
  "How to work:",
  "- Find the command: match the request's own words to the help descriptions and to any list of commands you may run; drill down with --help from the most specific group.",
  "- Help output is documentation, not task evidence. A group heading is not an action: use a complete child command path from its help, with the child before any flags. Do not call the group path with flags.",
  "- Use the installed commands listed above when they fit; otherwise find one with --help (aux4 --help lists every group). If group help lists subcommands, choose one and put it before its flags; repeating the group with different flags does not run a subcommand. A package name (scope/name) is not a command.",
  "- Never guess a command name. If a call returns \"Command not found\", run --help on its parent group (drop the last word) and use a command listed there, or look for another command that does the same thing.",
  "- executeAux4 adds the aux4 binary: pass only the command path and flags shown below, without an aux4 prefix.",
  "- Before first using a command that changes something, read its --help for the exact parameter names. Once a change succeeds, do not run it again.",
  "- Before sending to a person, obtain their exact address from the request or a successful lookup. A person's name does not establish an address; never invent one or copy an example from help.",
  "- Before anything that cannot be undone (sending, deleting, paying), first get the facts it depends on from the tools, then say in one sentence what they mean for the action (e.g. whether the time is free) and act on exactly that.",
  "- When changing an existing record, change only requested attributes and preserve the rest from the record you read. For a time-only change, keep the item's observed date and time zone. Carry its UTC offset or explicit named zone into machine timestamps; do not silently drop the zone or substitute today's date.",
  "- When describing a timed item, include the complete start-to-end range if both endpoints are present in the evidence.",
  "- Before sending or submitting a message, re-read the tool results it depends on and make sure the message agrees with them.",
  "- When a command rejects an option, use that command's exact --help to remove or replace the unsupported option, then continue the remaining steps; never retry an option the command rejected.",
  "- A successful click or tool status is not proof that a requested change happened. Verify the resulting state once, and claim completion only when the evidence shows the requested outcome.",
  "- If an action returns \"User aborted\", the requester declined it: stop and say so, do not retry it.",
  "- After a successful lookup, reuse its facts; rerun it only if a change or new evidence could have changed the result. Repeated nonempty facts should be reused; an empty filtered result may require one broader lookup before deciding the target is absent.",
  "- Read each lookup result before choosing the next step. A filtered miss does not establish absence: try one materially broader scope while preserving explicit user constraints. Do not repeat equivalent filters or superficial rewordings; if the broader lookup also adds nothing, report the missing information.",
  "- If a tool reports that a call or token budget is exhausted, stop making tool calls and report what remains incomplete.",
  "- For a background job, use a real wait interval or a polling command; do not issue back-to-back status checks when the job is still running.",
  "- Anything you send must name what it refers to (the item, the date and time), not just \"that\".",
  "- Never make up a value (an id, a code, a number, a name): use only values the request gives or a tool returned. If a required value cannot be found, do not submit or send -- say exactly what is missing.",
  "- Never ask the requester for something the tools can find out (a date, an id, a name): look it up. If a question is ambiguous, answer with the reading the results best support and say which."
].join("\n");

// Small models often cannot find a command three or four groups deep, so the
// harness looks up which installed commands fit the request (and each planned
// step) with `aux4 aux4 pkger find`, the same search the agent is told to use,
// and lists them. Commands of the agent itself are left out.
const FIND_LIMIT = 10;
const FIND_TIMEOUT_MS = 5000;
const MAX_FOUND = 12;
const MAX_LOOKUP_QUERIES = 5;
const MAX_PRESET_LOOKUPS = 1;
const MAX_HELP_OUTPUTS = 6;
const HELP_TIMEOUT_MS = 5000;
const HELP_OUTPUT_LIMIT = 1200;
const HELP_GROUP_OUTPUT_LIMIT = 3600;
const HELP_TOTAL_LIMIT = 5200;

// A URL is not a word the docs use: it is searched as "web page".
export function findQuery(text) {
  return String(text || "").replace(/https?:\/\/\S+/gi, "web page").trim().slice(0, 300);
}

const FIND_STOP_WORDS = new Set("a an and are as at be been but by can do does for from go had has have he her here him his how i if in into is it its me my no not of on or our she so that the their them there they this to up us was we were what when where which who why will with you your".split(" "));

function compactFindTerms(queries) {
  return [...new Set(String(queries || "").toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter(word => !FIND_STOP_WORDS.has(word))
    .slice(0, 24)
    .join(" ");
}

// pkger-finder prints human-readable command rows, not JSON. Keep accepting
// JSON too for older/local find implementations, but parse the documented
// text form so the agent can actually receive installed command references.
function parseFindResults(output) {
  const parsed = parseJSONLoose(output, null);
  if (Array.isArray(parsed)) return parsed;

  const lines = String(output || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].trim().match(/^(aux4(?:\s+\S+)+?)\s{2,}\(([^()]+)\)$/);
    if (!row) continue;
    const description = (lines[i + 1] || "").trim();
    results.push({ command: row[1], description });
  }
  return results;
}

export function findCommands(queries) {
  const lists = [];
  let searchFailed = false;
  const search = (query, serviceSearch = false) => {
    if (!query || searchFailed) return;
    const result = runAux4(["aux4", "pkger", "find", "--query", query, "--limit", String(FIND_LIMIT)], { allowFailure: true, timeout: FIND_TIMEOUT_MS });
    // A cold/stale index can make the first search exceed its bounded wait.
    // Repeating that rebuild for every phrase only burns time and CPU.
    if (!result.ok) {
      searchFailed = true;
      return;
    }
    const list = parseFindResults(result.stdout);
    if (!Array.isArray(list)) return;
    lists.push(list
      .map(item => ({ command: String(item?.command || "").trim(), description: String(item?.description || ""), serviceSearch }))
      .filter(item => item.command && !/^aux4 (ai agent|agent ask|aux4 pkger)(\s|$)/.test(item.command)));
  };
  const cleanQueries = queries.map(findQuery).filter(Boolean);
  for (const query of cleanQueries) {
    search(query);
    if (searchFailed) break;
  }

  // A matching mock preset names the service it configures (for example,
  // "aux4 mock preset <service>"). Search that service plus the same task
  // terms so the indexed setup command does not crowd out the service's actual
  // commands. The service name is discovered from pkger results.
  const presetServices = [...new Set(lists.flatMap(list => list
    .map(item => item.command.match(/^aux4 mock preset\s+(.+)$/)?.[1]?.trim())
    .filter(service => service && !/\b(?:auth|oauth|credentials?)\b/i.test(service))))].slice(0, MAX_PRESET_LOOKUPS);
  const taskTerms = compactFindTerms([cleanQueries[0], cleanQueries.at(-1)].filter(Boolean).join(" "));
  for (const service of presetServices) search(findQuery(`${service} ${taskTerms}`), true);

  // A command that ranks well for several distinct task phrases is a better
  // lead than unrelated first-place results from each query. Reciprocal rank
  // avoids comparing the search provider's raw scores across queries.
  const found = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const existing = found.get(item.command) || { ...item, hits: 0, rankScore: 0, bestRank: rank, serviceBestRank: Infinity };
      existing.hits++;
      existing.rankScore += 1 / (rank + 1);
      existing.bestRank = Math.min(existing.bestRank, rank);
      existing.serviceSearch ||= item.serviceSearch;
      if (item.serviceSearch) existing.serviceBestRank = Math.min(existing.serviceBestRank, rank);
      if (!existing.description && item.description) existing.description = item.description;
      found.set(item.command, existing);
    });
  }
  return [...found.values()]
    .sort((a, b) => Number(b.serviceSearch) - Number(a.serviceSearch)
      || (a.serviceSearch && b.serviceSearch ? a.serviceBestRank - b.serviceBestRank : 0)
      || b.rankScore - a.rankScore || b.hits - a.hits || a.bestRank - b.bestRank)
    .filter(({ command }) => !/^aux4 mock preset\s/.test(command))
    .slice(0, MAX_FOUND)
    .map(({ command, description }) => ({ command, description }));
}

function commandHelp(command, limit = HELP_OUTPUT_LIMIT) {
  const parts = String(command || "").trim().split(/\s+/);
  // pkger find returns command paths, not invocations. Only ask for help on a
  // plain aux4 path; never execute package-supplied arguments as a command.
  if (parts[0] !== "aux4" || parts.length < 2 || parts.slice(1).some(part => !/^[a-zA-Z0-9:_-]+$/.test(part))) return "";
  // executeAux4 accepts the path after the `aux4` binary; runAux4 supplies the
  // binary itself. Keep the package-provided command path out of shell parsing.
  const result = runAux4([...parts.slice(1), "--help"], { allowFailure: true, timeout: HELP_TIMEOUT_MS });
  return result.ok ? String(result.stdout || "").trim().slice(0, limit) : "";
}

// Show the command path expected by executeAux4. pkger find returns shell
// paths prefixed with `aux4`, but the tool supplies that binary itself.
// Command search works on short phrases about what a command does ("read email
// in the inbox"); a whole task sentence pulls in commands that merely share a
// word with it ("order" -> a todo list's order). The plan's lookFor phrases are
// searched when there are any; otherwise the request and its steps.
export function lookupQueries(request, plan) {
  const lookFor = Array.isArray(plan?.lookFor) ? plan.lookFor.filter(Boolean) : [];
  const steps = Array.isArray(plan?.steps) ? plan.steps.filter(Boolean) : [];
  const queries = lookFor.length
    ? [...lookFor.slice(0, MAX_LOOKUP_QUERIES - 2), ...steps.slice(0, MAX_LOOKUP_QUERIES - lookFor.length - 1), request, ...lookFor.slice(MAX_LOOKUP_QUERIES - 2)]
    : [request, ...steps];
  return [...new Set(queries.map(query => String(query || "").trim()).filter(Boolean))].slice(0, MAX_LOOKUP_QUERIES);
}

export function describeFoundCommands(found) {
  if (!found.length) return "";
  let remaining = HELP_TOTAL_LIMIT;
  let helped = 0;
  const describedGroups = new Set();
  const lines = [
    "Installed aux4 command reference (exact syntax from --help). Pass the shown command path and flags to executeAux4; it adds the aux4 binary. Use these flags directly without another help lookup. Group headings are not actions: run a complete listed child path before adding flags:"
  ];

  // Search may return a group rather than the leaf command that completes the
  // request. Prefer the exact, deepest matched group so its child commands are
  // visible before broad ancestor help consumes the prompt budget.
  const groupCandidates = [];
  for (const f of found) {
    const parts = String(f.command || "").trim().split(/\s+/);
    const command = String(f.command || "").trim();
    const group = parts[0] === "aux4"
      ? (/\bcommand group\b/i.test(f.description || "")
        ? command
        : parts.length >= 4 ? parts.slice(0, -1).join(" ") : "")
      : "";
    if (group && !groupCandidates.includes(group)) groupCandidates.push(group);
  }

  const deepestGroups = groupCandidates.filter(group =>
    !groupCandidates.some(other => other !== group && other.startsWith(`${group} `)));
  deepestGroups.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length
    || groupCandidates.indexOf(a) - groupCandidates.indexOf(b));
  const references = [];
  for (const group of deepestGroups.slice(0, MAX_HELP_OUTPUTS)) {
    const groupHelp = commandHelp(group, HELP_GROUP_OUTPUT_LIMIT * 3);
    if (!groupHelp) continue;
    const helpLines = groupHelp.split(/\r?\n/);
    const children = [];
    for (let i = 0; i < helpLines.length; i++) {
      const name = helpLines[i].match(/^ {2}([a-zA-Z][a-zA-Z0-9:_-]*)\s*$/)?.[1];
      if (!name) continue;
      const nextLine = (helpLines[i + 1] || "").trim();
      const description = nextLine.startsWith("--") ? "" : nextLine.slice(0, 100);
      const flags = [];
      for (let j = i + 1; j < helpLines.length && !/^ {2}[a-zA-Z][a-zA-Z0-9:_-]*\s*$/.test(helpLines[j]); j++) {
        const flag = helpLines[j].match(/^ {4}(--[a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([^\n]+))?$/);
        if (flag) flags.push(`${flag[1]}${flag[2] === "<arg>" ? " <arg>" : ""}`);
      }
      children.push({ name, description, flags });
    }
    const commandPath = group.replace(/^aux4\s+/, "");
    const paths = [...new Set(children.map(child => `${commandPath} ${child.name}`))];
    const heading = paths.length
      ? `- ${commandPath} (group; complete child paths: ${paths.join(", ")})`
      : `- ${commandPath}`;
    const outline = children.map(child => `  ${commandPath} ${child.name}: ${child.description}`).join("\n");
    const index = `${heading}\n${outline}`;
    if (index.length > remaining) continue;
    lines.push(index);
    remaining -= index.length;
    describedGroups.add(group);
    references.push({ commandPath, groupHelp, children });
    helped++;
  }
  // Reserve the command index for EVERY matched group before spending the
  // remaining budget on verbose flags from any single group. A large first
  // service must not hide the follow-up reads in another service.
  // Compact parameter names precede verbose prose so later child commands
  // have a usable contract too. Keep every group index reserved first.
  for (let i = 0; i < references.length; i++) {
    const { commandPath, children } = references[i];
    const budget = Math.floor(remaining / (references.length - i));
    let used = 0;
    for (const child of children) {
      if (!child.flags.length) continue;
      const signature = `  ${commandPath} ${child.name} Parameters: ${child.flags.join(", ")}.`;
      if (used + signature.length + 1 > budget) continue;
      lines.push(signature);
      used += signature.length + 1;
    }
    remaining -= used;
  }
  for (let i = 0; i < references.length; i++) {
    const { commandPath, groupHelp } = references[i];
    const limit = Math.min(HELP_GROUP_OUTPUT_LIMIT, Math.floor(remaining / (references.length - i)));
    if (limit <= 0) continue;
    const clipped = groupHelp.slice(0, limit);
    lines.push(`  Parameter details for ${commandPath}:\n${clipped.split("\n").map(line => `  ${line}`).join("\n")}`);
    remaining -= clipped.length;
  }

  for (const f of found) {
    const commandPath = String(f.command || "").replace(/^aux4\s+/, "");
    const parts = String(f.command || "").trim().split(/\s+/);
    const group = parts[0] === "aux4" && parts.length >= 4 ? parts.slice(0, -1).join(" ") : "";
    if (describedGroups.has(f.command) || (group && describedGroups.has(group))
      || [...describedGroups].some(parent => f.command.startsWith(`${parent} `))
      || (/\bcommand group\b/i.test(f.description || "")
        && [...describedGroups].some(child => child.startsWith(`${f.command} `)))) {
      continue;
    }
    const help = helped < MAX_HELP_OUTPUTS ? commandHelp(f.command) : "";
    if (help && remaining > 0) {
      const clipped = help.slice(0, remaining);
      lines.push(`- ${commandPath}\n${clipped.split("\n").map(line => `  ${line}`).join("\n")}`);
      remaining -= clipped.length;
      helped++;
    } else {
      const description = f.description ? ` -- ${f.description.split("\n")[0].slice(0, 100)}` : "";
      lines.push(`- executeAux4 {"command": "${commandPath} --help"}${description}`);
    }
  }
  return lines.join("\n");
}

export function preferredDelegation(request, delegations = []) {
  const text = String(request || "");
  const directApi = /\b(endpoint|REST|GraphQL|curl)\b|\b(?:API|JSON)\s+(?:request|response|payload)\b|\b(?:fetch|get|return)\s+(?:the\s+)?JSON\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+(?:request|https?:\/\/)/i;
  if (!/https?:\/\/\S+/i.test(text) || directApi.test(text)) return null;
  const terms = words(text);
  return delegations.find(d => d.urlTasks &&
    (!(d.requestWords || []).length || d.requestWords.some(word => terms.has(word)))) || null;
}

export function executionCommandReference(request, plan, delegations = []) {
  const delegate = preferredDelegation(request, delegations);
  if (!delegate) return describeFoundCommands(findCommands(lookupQueries(request, plan)));
  const group = delegate.via.replace(/:/g, " ");
  const lines = [
    "Registered goal-level capability for this page task. Use it to inspect and complete the requested outcome; discover additional commands if another part of the request needs them:",
    "For a command accepting --goal, pass the complete requested outcome, supplied values, and exclusions. A partial lookup goal can hide values the user already gave. Use --question for information-only lookups. If a tool reports missing required values, reuse the original request and successful evidence; if still unavailable after one relevant source, stop and name what is missing. Authorization does not replace required data."
  ];
  for (const child of delegate.entrypoints || []) {
    const command = `aux4 ${group} ${child}`;
    const help = commandHelp(command, HELP_OUTPUT_LIMIT);
    lines.push(`- ${group} ${child}${help ? `\n${help}` : " --help"}`);
  }
  // A registered delegate covers its own domain, not prerequisite facts in
  // another service. Discover the remaining planned capabilities instead of
  // hiding them merely because the request also contains a page URL.
  const queries = Array.isArray(plan?.lookFor) ? plan.lookFor.filter(Boolean) : [];
  if (queries.length) {
    const covered = delegations.flatMap(item => [item.via, item.group].filter(Boolean).map(value => value.replace(/:/g, " ")));
    const supplemental = findCommands(queries).filter(item => {
      const command = item.command.replace(/^aux4\s+/, "");
      return !covered.some(prefix => command === prefix || command.startsWith(`${prefix} `));
    });
    const reference = describeFoundCommands(supplemental);
    if (reference) lines.push("Additional installed capabilities for the other planned operations (the registered goal capability still owns its page work):\n" + reference);
  }
  return lines.join("\n");
}

export function composeExecuteQuestion(request, plan, recovery = "", foundCommands = "", delegationNote = "") {
  const criteria = plan.doneCriteria.map(c => `- ${c}`).join("\n");
  const steps = plan.steps.length ? `\n\nPossible starting points (provisional, revise as you learn more):\n${plan.steps.map(s => `- ${s}`).join("\n")}` : "";
  const recoveryNote = recovery
    ? `\n\nA previously attempted shortcut failed. Complete the request another way. Failure:\n${String(recovery).slice(0, 4000)}`
    : "";
  return [
    request,
    "",
    "This request is done only when every one of the following is true:",
    criteria,
    "",
    ...(foundCommands ? [foundCommands, ""] : []),
    ...(delegationNote ? [delegationNote, ""] : []),
    WORKING_RULES,
    steps,
    recoveryNote
  ].join("\n");
}

// Policy deny entries are globs, so a failed command that itself contains "*"
// would deny more than that one command; those are left out.
// A retry fixes one specific failure, so it gets a small tool budget: a model
// that starts looping on refused calls is stopped quickly.
export const RETRY_CALL_BUDGET = 10;

export function capRetryBudget(policyJSON) {
  const policy = parseJSONLoose(policyJSON, {}) || {};
  const calls = policy?.budget?.calls;
  const capped = typeof calls === "number" ? Math.min(calls, RETRY_CALL_BUDGET) : RETRY_CALL_BUDGET;
  return JSON.stringify({ ...policy, budget: { ...(policy.budget || {}), calls: capped } });
}

// A capability that has a goal-level agent is reached through that agent: the
// low-level commands it drives are not for the calling agent (a model that knows
// them from training goes around the agent and drives every click itself).
// Only the calling agent's own executeAux4 calls are denied; the goal-level
// agent runs the low-level commands as its own processes, untouched.
export const DELEGATIONS = [
  {
    via: "agent:browser",
    group: "browser",
    urlTasks: true,
    planningScope: "Inspect extracted content and complete tasks on the provided web pages, including controls, forms, navigation and saving requested page changes. Page inspection covers only blocks emitted from the current rendered page and does not establish website-wide or paginated collection completeness. This does not supply facts stored in separate services",
    entrypoints: ["run", "find", "inspect"],
    note: "Web pages: the \"agent browser\" command group is available to you; the raw \"browser\" command group is not. For any task performed on a web page, use executeAux4 with the appropriate agent browser command. For a deterministic read of extracted content on the current rendered page, use command \"agent browser inspect --url <page>\" (or --session <session>); this does not require semantic ranking. Its completeness applies only to blocks emitted by the extractor on that page, not every visible text fragment, other pages, or the whole website. Continue only through observed navigation controls when the task concerns more pages. Use \"agent browser find --url <page> --question \\\"<what to find>\\\"\" for ranked evidence, which may return relevant matches without proving that its list is exhaustive. For page tasks that require changes, use executeAux4 with command \"agent browser run --url <page> --goal \\\"<requested outcome>\\\"\". The supplied URL is a browser destination for page work, not a request to call its API directly. Pass all provided values as repeated --field \"Label=value\" flags. Let one run inspect, fill, save/submit, and report the result; do not split it into atomic clicks or fills unless it returns a blocker or asks for missing input. Reuse a returned live session id for follow-up; when sessionClosed is true or session is absent, reopen an observed source URL. For a web change, identify the target from observed page data and name only requested fields. A click is not proof of a saved or deleted result: verify the resulting state once before claiming success. Use observed links, forms and commands; never guess routes, identifiers or API methods. If a run is incomplete, take a materially different evidence-based step."
  }
];

// Installed profiles, from aux4's own command file (read only).
export function installedProfiles(file = process.env.AUX4_GLOBAL_FILE || path.join(process.env.HOME || "", ".aux4.config", "global.aux4")) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set((data?.profiles || []).map(p => p.name));
  } catch {
    return new Set();
  }
}

export function activeDelegations(profiles = installedProfiles()) {
  return DELEGATIONS.filter(d => profiles.has(d.via));
}

export function delegatedDenyPatterns(delegations) {
  return delegations.flatMap(d => [d.group, `${d.group} *`, `aux4 ${d.group}`, `aux4 ${d.group} *`]);
}

// Adds glob deny patterns to a policy (mergeDenyPolicy only takes literal
// failed commands, never globs. `targetPatterns` are generated internally from
// a successful change's stable target flags, so they may safely use wildcards.
// `reason`, when given, is told to the agent when one of these patterns denies a call
// (aux4/ai-agent >= 1.3.7), so a blocked command says what to use instead.
export function addDenyPatterns(policyJSON, patterns, reason = "") {
  const policy = parseJSONLoose(policyJSON, {}) || {};
  if (!patterns.length) return JSON.stringify(policy);
  const deny = Array.isArray(policy.deny) ? [...policy.deny] : [];
  const existing = new Set(deny.flatMap(entry => entry?.executeAux4 || []));
  const fresh = patterns.filter(p => !existing.has(p));
  if (fresh.length) deny.push(reason ? { executeAux4: fresh, reason } : { executeAux4: fresh });
  return JSON.stringify({ ...policy, deny });
}

export function mergeDenyPolicy(policyJSON, failedCommands, targetPatterns = []) {
  const policy = parseJSONLoose(policyJSON, {}) || {};
  if (!failedCommands.length && !targetPatterns.length) return JSON.stringify(policy);
  const deny = Array.isArray(policy.deny) ? [...policy.deny] : [];
  const existing = new Set();
  for (const entry of deny) {
    for (const pattern of entry?.executeAux4 || []) existing.add(pattern);
  }
  const exact = [...new Set(failedCommands)].filter(cmd => cmd && !cmd.includes("*") && !existing.has(cmd));
  const targeted = [...new Set(targetPatterns)].filter(pattern => pattern && !existing.has(pattern));
  const fresh = [...exact, ...targeted];
  if (fresh.length) deny.push({ executeAux4: fresh });
  return JSON.stringify({ ...policy, deny });
}

// --- Stop conditions --------------------------------------------------------

// A round where nothing actually failed -- every unmet criterion is only
// unverifiable -- after a change already succeeded has nothing left for a
// retry to add: the one thing a retry could do to satisfy a state criterion
// is run the change again, and a change that already succeeded is denied on
// every later round (see deniedCommands below). Spending a whole execute
// round to repeat a denied call and land on the same verdict teaches nothing,
// so the loop stops here instead, with the best answer it already has.
export function unverifiableOnlyAfterChange(verdict, attempts) {
  if (!verdict || verdict.overall === "pass") return false;
  if (verdict.criteria.some(c => c.status === "fail")) return false;
  if (!verdict.criteria.some(c => c.status === "unverifiable")) return false;
  return attempts.some(a => isConclusiveAttempt(a) && isChangeCommand(a.command));
}

export function sameFailureShape(a, b) {
  if (!a || !b) return false;
  const key = verdict => verdict.criteria
    .filter(c => c.status !== "pass")
    .map(c => `${c.criterion}::${c.status}`)
    .sort()
    .join("|");
  return key(a) === key(b);
}

// A retry can change the wording of a search without learning anything new.
// Compare read results while ignoring query and request metadata, but retain
// returned facts such as ids, dates, and page contents.
const EPHEMERAL_EVIDENCE_KEYS = new Set([
  "session", "sessionid", "requestid", "correlationid", "traceid",
  "question", "answerscore", "usage", "wallms", "rankcalls",
  "duration", "elapsed", "elapsedms", "runtime"
]);

function stableEvidence(value) {
  if (Array.isArray(value)) return value.map(stableEvidence);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !EPHEMERAL_EVIDENCE_KEYS.has(key.toLowerCase()))
    .map(key => [key, stableEvidence(value[key])]));
}

function readEvidenceKey(attempt) {
  const raw = String(attempt?.source ?? attempt?.result ?? "").trim();
  if (!raw) return "";
  try {
    return JSON.stringify(stableEvidence(JSON.parse(raw)));
  } catch {
    return raw.replace(/\s+/g, " ");
  }
}

export function sameReadEvidence(current, previous) {
  const priorReads = previous.filter(a => !a.failed && isReadCommand(a.command));
  const currentReads = current.filter(a => !a.failed && isReadCommand(a.command));
  if (!priorReads.length || !currentReads.length) return false;
  const prior = new Set(priorReads.map(readEvidenceKey).filter(Boolean));
  return prior.size > 0 && currentReads.every(a => {
    const key = readEvidenceKey(a);
    return key && prior.has(key);
  });
}

// When a denied command came back with the list of commands that may run, the
// agent is not blocked: it has not yet tried what it is allowed to use.
// An unrelated question or help lookup must not hide a still-unresolved
// pre-action guard. A real subsequent lookup/change gets its normal verification.
export function unresolvedActionGuard(attempts) {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    const text = String(attempt.source ?? attempt.result ?? "");
    if (attempt.declined) return null;
    if (attempt.failed && /ACTION_CHECK_(?:EVIDENCE_REQUIRED|SCOPE_DENIED)/.test(text)) return attempt;
    if (!attempt.failed && !/(?:^|\s)(?:--help|-h)(?:\s|$)/.test(attempt.command || "")
      && (isReadCommand(attempt.command) || (isConclusiveAttempt(attempt) && isChangeCommand(attempt.command)))) return null;
  }
  return null;
}

export function allowedCommandsOffered(attempts) {
  for (const a of [...attempts].reverse()) {
    const m = String(a.result || "").match(/Commands you may run:\s*([^\n]+)/i);
    if (m) return m[1].replace(/\.\s*Use one of these.*$/i, "").trim();
  }
  return "";
}

// The round ended with a question to the requester without a single tool
// call: whatever it asks for is usually something the tools can tell.
export function askedWithoutLooking(content, roundToolCalls) {
  return roundToolCalls === 0 && /\?\s*$/.test(stripFailureClass(content));
}

export const LOOK_BEFORE_ASKING = "You asked the requester a question without using any tool. Do not ask: find the answer with the tools first (look for the command whose help matches the request's words), then finish the request.";

export function composeNotBlockedQuestion(offered) {
  return [
    "You are not blocked yet: a permission message listed the commands you may run.",
    `Commands you may run: ${offered}`,
    "Pick the one whose name matches what you need (check its --help for parameters), use it, and finish the request.",
    CHECK_BEFORE_IRREVERSIBLE
  ].join("\n");
}

export const BLOCKED_MARK = "BLOCKED:";

export function isBlocked(executeOutput) {
  const text = String(executeOutput || "");
  const trimmed = text.trim();
  // Preserve the original case-insensitive colon marker contract. The bare
  // token form is deliberately stricter: it must be the first unquoted token
  // and uppercase, with a token boundary after it.
  const explicitToken = /^BLOCKED(?=$|[\s:])/.test(trimmed);
  return trimmed.toUpperCase().startsWith(BLOCKED_MARK) || explicitToken || extractFailureClass(text) === "blocked";
}

// A retry that only described what it would do, without a single tool call.
export const DO_IT_NOW = "You described what to do but did not call any tool. Do it now: make a real tool call (a function call, not text) for the next step.";

export const TEXT_TOOL_CALL = /^\s*`?\w+\(\s*["'{]/;

// Small models copy their own last output: a tool call written as text stays
// in the history and gets written again. Drop that trailing text-only reply
// so the push starts from a clean state.
export function dropTrailingTextCall(historyFile) {
  if (!historyFile || !fs.existsSync(historyFile)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && typeof last.content === "string" && TEXT_TOOL_CALL.test(last.content)) {
      messages.pop();
      fs.writeFileSync(historyFile, JSON.stringify({ ...data, messages }));
      return true;
    }
  } catch {
    // leave the history as it is
  }
  return false;
}

export function describedWithoutDoing(content, roundToolCalls) {
  const text = stripFailureClass(content);
  if (roundToolCalls !== 0) return false;
  // Narrated intent, or a tool call written out as text instead of made.
  return /\b(I will|I'll|I need to|I am going to|let me)\b/i.test(text) || TEXT_TOOL_CALL.test(text);
}

// The failure-class line is for the harness, not the requester.
export function stripFailureClass(text) {
  return String(text || "").replace(/^\s*FAILURE_CLASS:\s*[a-z_]+\s*\n?/gim, "")
    .replace(/^\s*BLOCKED:\s*/i, "").replace(/^\s*BLOCKED(?=\s|$)\s*/, "").trim();
}

export function appendStatusNote(content, note) {
  if (!note) return content;
  return content ? `${content}\n\n${note}` : note;
}

export function incompleteNote(verdict) {
  const failed = verdict.criteria.filter(c => c.status !== "pass");
  if (!failed.length) return "";
  const lines = failed.map(c => `- ${c.criterion}: ${c.status} (${c.evidence})`).join("\n");
  return `Not fully confirmed:\n${lines}`;
}

// --- Orchestrator -----------------------------------------------------------

// Runs the full plan -> execute -> verify -> diagnose -> retry loop around a
// single conversation turn. `execute(question, history, denyCommands)` must
// perform one real execution turn (a normal `aux4 ai agent ask` call against
// the caller's own history/conversation) and return its stdout text.
export async function runLoop(options, history, execute, recovery = "") {
  const planStart = Date.now();
  const planHistory = phaseHistoryPath(history, "plan-run");
  const plan = buildPlan(options, planHistory);
  savePlan(history, { ...plan, ms: Date.now() - planStart });
  const metrics = { plan: { ...historyStats(planHistory), ms: Date.now() - planStart }, rounds: [] };
  const previousActionChecks = new Set(actionCheckFiles(history));

  let deniedCommands = [];
  let deniedPatterns = [];
  let priorVerdict = null;
  let lastContent = "";
  // The last non-empty answer: a round that ends in an empty reply must not
  // erase an earlier round's answer from the final output.
  let lastAnswer = "";
  let lastVerdict = null;
  let pushedPastBlocked = false;
  let lookFirst = false;
  let confirmOpen = false;
  let commitGranted = false;
  let nextQuestion = "";
  let recoveryHint = "";
  const priorCommands = new Set();
  const done = (stopped, attempt, note = "") => {
    metrics.stopped = stopped;
    metrics.actionChecks = actionCheckStats(history, previousActionChecks);
    metrics.total = [metrics.plan, metrics.actionChecks, ...metrics.rounds.flatMap(r => [r.execute, r.verify || {}])]
      .reduce((acc, s) => addStats(acc, s), {});
    saveMetrics(history, metrics);
    return {
      content: appendStatusNote(executionProofContent(stripFailureClass(String(lastContent || "").trim() ? lastContent : lastAnswer), lastVerdict, extractAttemptLog(history)), note),
      plan,
      verdict: lastVerdict,
      stopped,
      attempts: attempt,
      metrics
    };
  };
  let innerStopReason = "";
  const runExecution = async (...args) => {
    const result = await execute(...args);
    if (result && typeof result === "object" && !Array.isArray(result)) {
      innerStopReason = String(result.stopReason || "");
      return String(result.content ?? "");
    }
    innerStopReason = "";
    return String(result ?? "");
  };
  const stopAfterExecution = attempt => {
    if (!innerStopReason) return null;
    const reason = innerStopReason;
    innerStopReason = "";
    if (reason === "budget") {
      return done("tool-budget", attempt, "The model's tool-call budget was exhausted, so the remaining work could not be confirmed.");
    }
    // Stop the inner loop early, then let the outer plan/verify loop inspect
    // the evidence and make a bounded recovery attempt with a different route.
    recoveryHint = "The previous inner run was stopped after identical tool results repeated. Use a materially different action or evidence source; do not repeat that call. The task may still be recoverable.";
    return null;
  };

  for (let attempt = 1; attempt <= RETRY_BUDGET + 1; attempt++) {
    const executeStart = Date.now();
    // The two-step note describes the fallback gate only; with tool-call hooks
    // nothing is held, and telling the agent otherwise sends it round in circles.
    const notes = [...(options.delegations || []).map(d => d.note), ...(options.hooksSupported ? [] : [CONFIRM_NOTE])].join("\n");
    const questionBase = nextQuestion ? nextQuestion : attempt === 1
      ? composeExecuteQuestion(options.request, plan, recovery, executionCommandReference(options.request, plan, options.delegations), notes)
      : onlyAnswerFailed(plan, priorVerdict, extractAttemptLog(history))
        ? composeRewriteQuestion(priorVerdict)
        : composeDiagnoseQuestion(plan, priorVerdict, extractAttemptLog(history), options.request, lookFirst);
    const question = recoveryHint && attempt > 1 && !nextQuestion
      ? `${questionBase}\n\n${recoveryHint}`
      : questionBase;
    if (recoveryHint && !nextQuestion) recoveryHint = "";

    const before = extractAttemptLog(history).length;
    const messagesBefore = readMessages(history).length;
    const usageBefore = readTokenUsage(history);
    nextQuestion = "";
    // The gate opens for one round only: a later irreversible step is held again.
    // When ai-agent supports hooks (HARN-030), the confirmation is checked
    // in-round by its own `before` hook instead -- there is nothing left for
    // this permission-level gate to do, so it never denies the call.
    const gateOpen = confirmOpen || options.hooksSupported;
    confirmOpen = false;
    options.gateDeny = gateOpen ? [] : [CONFIRM_PATTERN, CONFIRM_DATA_PATTERN];
    lastContent = await runExecution(question, history, deniedCommands, attempt > 1, deniedPatterns);
    if (String(lastContent || "").trim()) lastAnswer = lastContent;
    const round = { attempt, execute: { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart } };
    metrics.rounds.push(round);
    const innerStop = stopAfterExecution(attempt);
    if (innerStop) return innerStop;
    if (extractAttemptLog(history).slice(before).some(a => isBudgetExceededResult(a.source))) {
      return done("tool-budget", attempt, "The model's tool-call budget was exhausted, so the remaining work could not be confirmed.");
    }
    // One push per round, straight away (cheaper than verifying a round that
    // did nothing): a question asked without looking, or a step described or
    // written out as text instead of carried out.
    if (!isBlocked(lastContent)) {
      const push = askedWithoutLooking(lastContent, round.execute.toolCalls) ? LOOK_BEFORE_ASKING
        : describedWithoutDoing(lastContent, round.execute.toolCalls) ? DO_IT_NOW : "";
      if (push) {
        if (push === DO_IT_NOW) dropTrailingTextCall(history);
        lastContent = await runExecution(push, history, deniedCommands, false, deniedPatterns);
        if (String(lastContent || "").trim()) lastAnswer = lastContent;
        round.execute = { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart, pushed: push === DO_IT_NOW ? "do-it-now" : "look-first" };
        const innerStop = stopAfterExecution(attempt);
        if (innerStop) return innerStop;
      }
    }

    // A guard's refusal is a request to correct one proposed action. The model
    // may phrase that as ordinary prose rather than the BLOCKED marker, so
    // recover from the unresolved tool result itself before paying for verify.
    const pendingGuard = unresolvedActionGuard(extractAttemptLog(history).slice(before));
    if (!pushedPastBlocked && pendingGuard) {
      pushedPastBlocked = true;
      lastContent = await runExecution("The last proposed change was stopped before it ran. That does not establish that the request needs user input. An unrelated question or documentation call did not resolve the missing evidence. Read the guard's reason and obtain the missing evidence with an actual available lookup before asking the requester; if that lookup cannot establish it, report what is missing. Preserve every exclusion and do not repeat a successful change.\n\nUnresolved guard and available lookup contract:\n" + String(pendingGuard.source ?? pendingGuard.result ?? "").slice(0, 5000), history, deniedCommands, false, deniedPatterns);
      if (String(lastContent || "").trim()) lastAnswer = lastContent;
      round.execute = { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart, pushed: "action-check-recovery" };
      const innerStop = stopAfterExecution(attempt);
      if (innerStop) return innerStop;
    }

    if (isBlocked(lastContent)) {
      const currentLog = extractAttemptLog(history);
      const offered = allowedCommandsOffered(currentLog);
      if (pushedPastBlocked || !offered) return done("blocked", attempt);
      pushedPastBlocked = true;
      lastContent = await runExecution(composeNotBlockedQuestion(offered), history, deniedCommands, false, deniedPatterns);
      if (String(lastContent || "").trim()) lastAnswer = lastContent;
      round.execute = { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart };
      const innerStop = stopAfterExecution(attempt);
      if (innerStop) return innerStop;
      if (isBlocked(lastContent)) return done("blocked", attempt);
    }

    let attempts = extractAttemptLog(history);
    // The requester declined to confirm an action in this attempt: asking
    // again would only repeat the question, so report and stop.
    if (attempts.slice(before).some(a => a.declined)) return done("declined", attempt);

    // A confirmation held this round: check the entered values before it may run.
    const held = gateOpen ? null : heldConfirmation(attempts);
    if (held && held.index >= before) {
      const unsourced = unsourcedValues(attempts.slice(0, held.index + 1), options.request);
      round.confirmation = { command: held.command, unsourced: unsourced.map(u => `${u.label}=${u.value}`) };
      if (!unsourced.length) {
        confirmOpen = true;
        deniedCommands = deniedCommands.filter(c => !/confirm=yes/.test(c));
        nextQuestion = composeConfirmQuestion(held.command);
        // The commit round is the second half of one action, not a retry.
        if (!commitGranted) { commitGranted = true; attempt--; }
        continue;
      }
      nextQuestion = composeNotConfirmedQuestion(unsourced);
      if (attempt > RETRY_BUDGET) { lastVerdict = applyProvenance({ overall: "fail", criteria: [] }, attempts, options.request); return done("budget", attempt, incompleteNote(lastVerdict)); }
      continue;
    }

    // A tool stopped itself before an irreversible step this round and handed
    // back a pending confirmation (HARN-035) instead of a denial -- nothing
    // was held by policy, so the gate above never saw it. Decide once,
    // deterministically: run it now, in the SAME round, only when the request
    // itself clearly asks for it; otherwise stop and ask -- an ambiguous case
    // is treated exactly like one that is clearly not requested.
    let pending = attempts.length > before ? pendingConfirmation(attempts.slice(before)) : null;
    if (pending?.emptyFields.length) {
      const question = [
        "The tool is waiting for required values, not permission to submit.",
        `Required fields still empty: ${pending.emptyFields.join("; ")}.`,
        `Original request: ${options.request}`,
        "Fill values already supplied by the request or successful evidence. Use one relevant available lookup for anything still missing; do not search the same content repeatedly or retry a denied source. Do not run a confirmation command while required values remain absent. If a value cannot be obtained, stop with BLOCKED and name it."
      ].join("\n");
      lastContent = await runExecution(question, history, deniedCommands, false, deniedPatterns);
      if (String(lastContent || "").trim()) lastAnswer = lastContent;
      round.execute = { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart, pushed: "missing-input-recovery" };
      const innerStop = stopAfterExecution(attempt);
      if (innerStop) return innerStop;
      if (isBlocked(lastContent)) return done("blocked", attempt);
      attempts = extractAttemptLog(history);
      const remaining = pendingConfirmation(attempts.slice(before));
      if (remaining?.emptyFields.length) {
        lastContent = `The action has not been submitted. Required values are still missing: ${remaining.emptyFields.join("; ")}.`;
        return done("needs-input", attempt);
      }
      pending = remaining;
    }
    if (pending) {
      if (isClearlyRequestedAction(pending.label, options.request)) {
        const priorGate = options.gateDeny;
        options.gateDeny = [];
        lastContent = await runExecution(composeRunNextQuestion(pending), history, deniedCommands, false, deniedPatterns);
        if (String(lastContent || "").trim()) lastAnswer = lastContent;
        options.gateDeny = priorGate;
        round.execute = { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart, pushed: "confirm-requested" };
        round.confirmation = { command: pending.command, next: pending.next, requested: true };
        const innerStop = stopAfterExecution(attempt);
        if (innerStop) return innerStop;
        attempts = extractAttemptLog(history);
      } else {
        round.confirmation = { command: pending.command, next: pending.next, requested: false };
        lastContent = composeNeedsConfirmationAnswer(pending);
        return done("needs-confirmation", attempt);
      }
    }

    const verifyStart = Date.now();
    lastVerdict = runVerify(options, plan, lastContent, attempts, verifyHistoryPath(history, attempt));
    round.verify = { ...historyStats(verifyHistoryPath(history, attempt)), ms: Date.now() - verifyStart };
    saveVerdict(history, attempt, attempts, { ...lastVerdict, ms: { execute: verifyStart - executeStart, verify: Date.now() - verifyStart } });

    if (lastVerdict.overall === "pass") return done("pass", attempt);
    // Nothing failed, only what the harness could not observe remains, and
    // the change behind it already ran -- a retry would just repeat a denied
    // command for the same inconclusive verdict. Stop now with the best answer.
    if (unverifiableOnlyAfterChange(lastVerdict, attempts)) return done("unverifiable-only", attempt, incompleteNote(lastVerdict));
    // A new command that returns the same read evidence is only a renamed
    // retry. Preserve attempts that introduce new evidence or change state.
    const previousAttempts = attempts.slice(0, before);
    const currentAttempts = attempts.slice(before);
    const triedSomethingNew = currentAttempts.some(a => !priorCommands.has(a.command));
    const repeatedReadOnly = sameReadEvidence(currentAttempts, previousAttempts);
    const changedState = currentAttempts.some(a => isConclusiveAttempt(a) && isChangeCommand(a.command));
    if (sameFailureShape(priorVerdict, lastVerdict) && (!triedSomethingNew || (repeatedReadOnly && !changedState))) {
      return done("no-progress", attempt, incompleteNote(lastVerdict));
    }
    for (const a of attempts) priorCommands.add(a.command);
    if (attempt > RETRY_BUDGET) return done("budget", attempt, incompleteNote(lastVerdict));

    priorVerdict = lastVerdict;
    lookFirst = askedWithoutLooking(lastContent, round.execute.toolCalls);
    const newlyFailed = attempts.filter(a => a.failed && !a.declined).map(a => a.command);
    // A change that already went through must not be repeated by a retry.
    const completed = attempts.filter(a => isConclusiveAttempt(a) && isChangeCommand(a.command));
    const doneChanges = completed.map(a => a.command);
    deniedCommands = [...new Set([...deniedCommands, ...newlyFailed, ...doneChanges])];
    deniedPatterns = [...new Set([...deniedPatterns, ...completed.flatMap(a => changeDenyPatterns(a.command))])];
  }

  // Unreachable in practice (the loop above always returns), but keep a safe
  // fallback so the function never resolves to undefined.
  return done("budget", RETRY_BUDGET + 1);
}
