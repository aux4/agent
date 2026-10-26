#!/usr/bin/env node
// Generic plan -> execute -> verify -> diagnose -> retry loop around a single
// `aux4 ai agent ask` execution turn. Nothing here may reference a specific
// service, tool, or task domain -- only goals, outcomes, evidence, attempts,
// and failure types. The loop is orchestrated entirely through repeated
// `aux4 ai agent ask` invocations; no change is made to aux4/ai-agent itself.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  const result = askOnce(options, {
    instructions: planInstructionsPath(options.packageDir),
    history: planHistory,
    question: `Request:\n${options.request}\n\nRespond with ONLY the JSON plan object described in your instructions. No prose, no code fences.`,
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
  return /^\s*(error\b|permission denied|command not found)/i.test(text) || /⛔\s*policy denied/i.test(text) || isDeclinedResult(text);
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
        tool: call.name,
        args: call.args ?? {},
        command: describeCall(call.name, call.args),
        failed,
        declined: result ? isDeclinedResult(resultContent) : false,
        result: resultText.slice(0, RESULT_LIMIT),
        source: resultText.slice(0, SOURCE_LIMIT),
        resultSummary: resultText.slice(0, 300)
      });
    }
  }
  return attempts;
}

// --- Metrics ----------------------------------------------------------------

const NUDGE = /^you returned nothing\b/i;

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
    if (m?.role !== "assistant" && m?.role !== "assistant_with_tool") continue;
    stats.modelCalls++;
    const u = usageOf(m);
    stats.input += u.input;
    stats.cached += u.cached;
    stats.output += u.output;
    for (const call of getToolCalls(m)) {
      if (!call?.name) continue;
      stats.toolCalls++;
      const command = describeCall(call.name, call.args);
      if (seen.has(command)) stats.repeats++;
      seen.add(command);
      if (/(^|\s)--help(\s|$)/.test(command)) stats.help++;
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
    byCriterion.set(criterion, { criterion, status, evidence });
  }
  // Every fixed done-criterion must have a verdict; a criterion the verifier
  // silently dropped is treated as unverifiable, never as a pass.
  // Match by exact text first; small models often reword the criterion, so
  // fall back to position (the verifier is asked to answer in order).
  const ordered = results.filter(r => typeof r?.criterion === "string" || typeof r?.status === "string");
  const criteria = doneCriteria.map((c, i) => {
    const exact = byCriterion.get(c);
    if (exact) return exact;
    const r = ordered[i];
    if (r && ["pass", "fail", "unverifiable"].includes(r.status)) {
      return { criterion: c, status: r.status, evidence: typeof r.evidence === "string" ? r.evidence.trim() : "" };
    }
    return { criterion: c, status: "unverifiable", evidence: "the verifier did not report on this outcome" };
  });
  const overall = criteria.every(c => c.status === "pass") ? "pass" : "fail";
  return { overall, criteria };
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

// A pass on a state criterion only counts when it rests on the verifier's own
// observation made after the work. If the verify run made no checks of its
// own, those passes become unverifiable. Answer criteria are judged from the
// recorded tool results, so they need no new check.
export function requireOwnObservation(verdict, checks, stateCriteria = null) {
  if (checks.length > 0) return verdict;
  const isState = c => stateCriteria === null || stateCriteria.includes(c.criterion);
  // Earlier results show the state before or during the work, so neither a
  // pass nor a fail on a state criterion can rest on them alone.
  const criteria = verdict.criteria.map(c => c.status !== "unverifiable" && isState(c)
    ? { ...c, status: "unverifiable", evidence: `not observed by the verifier itself (it made no checks of its own)${c.evidence ? `; it said: ${c.evidence}` : ""}` }
    : c);
  return { overall: criteria.every(c => c.status === "pass") ? "pass" : "fail", criteria };
}

// What the verifier is given: the request verbatim, the criteria with their
// kind, the final answer, and every action with its raw result. Raw results
// are real observations the answer must agree with; they say nothing about the
// state after the work, which state criteria must look at again.
export function verifyPayload(plan, finalAnswer, attempts, request = "") {
  let budget = RESULTS_TOTAL_LIMIT;
  const actions = [];
  for (const a of [...attempts].reverse()) {
    const result = String(a.result ?? a.resultSummary ?? "").slice(0, Math.max(0, Math.min(RESULT_LIMIT, budget)));
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

const CHANGE_VERB = /\b(send|reply|forward|delete|remove|rm|trash|archive|update|patch|put|post|create|insert|add|set|write|move|cancel|modify|edit|rename|upload|publish|deploy|pay|approve|install|uninstall)\b/i;

// An allowlist, not a denylist: a command is re-run only when one of its
// command words (before the first flag) is a read verb and none is a change
// verb. A change verb nobody listed then simply means "not re-run".
const READ_VERB = new Set(["get", "list", "show", "view", "read", "find", "search", "describe", "fetch", "status", "count", "info", "inspect", "query", "freebusy", "ls", "cat"]);

export function isReadCommand(command) {
  if (!command || CHANGE_VERB.test(command)) return false;
  const words = [];
  for (const token of String(command).trim().split(/\s+/)) {
    if (token.startsWith("-")) break;
    words.push(token.toLowerCase());
  }
  return words.some(w => READ_VERB.has(w));
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

export function runReadBack(command) {
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env: process.env, timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
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
  return out;
}

function tokens(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

// A value is sourced when every word and number in it appears in the request or
// in a result the agent had already received -- "1990-03-14" from "14/03/1990"
// is; a "12345" that appears nowhere is not. Made-up values are the one thing
// the verifier cannot judge from the answer, so the harness checks them itself.
export function unsourcedValues(attempts, request = "") {
  const seen = new Set(tokens(request));
  const found = [];
  for (const attempt of attempts) {
    for (const { label, value } of enteredValues(attempt.command)) {
      const missing = tokens(value).filter(t => !seen.has(t));
      if (isPlaceholder(value) || missing.length) found.push({ label, value, command: attempt.command });
    }
    for (const t of tokens(attempt.source ?? attempt.result)) seen.add(t);
  }
  return found;
}

// Same provenance check as unsourcedValues, but for a call that has NOT run
// yet -- the hooks path (see "Hooks integration" below) checks the pending
// confirmation's own --field values against everything that happened before
// it, instead of re-parsing it out of a finished attempt log.
export function unsourcedFieldValues(fields, attempts, request = "") {
  const seen = new Set(tokens(request));
  for (const attempt of attempts) {
    for (const t of tokens(attempt.source ?? attempt.result)) seen.add(t);
  }
  const found = [];
  for (const raw of fields || []) {
    const entry = parseFieldEntry(raw);
    if (!entry) continue;
    const missing = tokens(entry.value).filter(t => !seen.has(t));
    if (isPlaceholder(entry.value) || missing.length) found.push(entry);
  }
  return found;
}

// --- Confirmation gate ---------------------------------------------------
// Anything that cannot be undone goes through a confirmation call (agent/browser
// stops before it and offers `--field 'confirm=yes'`). The harness cannot see a
// call while a round runs, so it holds every confirmation for one round: the
// confirmation is denied, the harness checks where every entered value came
// from, and only then lets the agent run it -- a made-up value never reaches
// the page.
export const CONFIRM_PATTERN = "*confirm=yes*";
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
    "The confirmation was NOT run, because these values did not come from anywhere:",
    ...lines,
    "",
    "Never make up a value. If you can find the real value with the tools, use it. Otherwise do not submit: reply saying exactly which value is missing."
  ].join("\n");
}

export const PROVENANCE_CRITERION = "every value entered or sent came from the request or a tool result";

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

// --- Hooks integration (HARN-030) -----------------------------------------
// aux4/ai-agent >=1.3.0 can check a tool call BEFORE it runs, inside the round
// (its own `--hooks`, following aux4 core's hook standard). When it's
// available, the provenance check becomes a `before` hook on
// agent:browser/run (gated on `field` containing `confirm=yes`, so only the
// confirmation call is ever checked) instead of the two-round gate above:
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

export function checkValuesHooksFile(packageDir) {
  return {
    hooks: [
      {
        tool: "executeAux4",
        command: "agent:browser/run",
        params: { field: "confirm=yes" },
        before: [
          `node ${packageDir}/lib/check-values.mjs --request "\${__request}" --history "\${__history}" --fieldsJson '\${field}'`
        ]
      }
    ]
  };
}

// Written once per run next to the history file so a hook hitting the same
// agent:browser/run call always reads the live history -- never a stale copy.
export function writeCheckValuesHooksFile(packageDir, history) {
  const file = `${history}.hooks.json`;
  fs.writeFileSync(file, JSON.stringify(checkValuesHooksFile(packageDir), null, 2));
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
  if (readNow) payload.currentState = { readJustNowWith: readNow.command, result: readNow.output };
  const stateFirst = hasState && readNow
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
  const observed = verifyHistory && !noReadPossible ? requireOwnObservation(verdict, checks, plan.stateCriteria || plan.doneCriteria) : verdict;
  return { ...applyProvenance(observed, attempts, options.request), checks: checks.map(c => c.command) };
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
    const m = String(a.result || a.resultSummary || "").match(/Error to enter the value of (\w+)/i);
    if (m) hints.push(`"${a.command.slice(0, 80)}" was missing the required --${m[1]} parameter: pass --${m[1]} with its value.`);
  }
  return hints.length ? ["", ...[...new Set(hints)]] : [];
}

// Every state criterion holds and only what the answer says is off: fix the
// answer, not the world.
// A rewrite-only retry ("do not run any more actions") is for an answer that
// misstates results it already has. With no successful tool result there is
// nothing to restate: the work was never done, so the retry must act.
export function onlyAnswerFailed(plan, verdict, attempts = null) {
  if (Array.isArray(attempts) && !attempts.some(a => !a.failed)) return false;
  const state = new Set(plan.stateCriteria || plan.doneCriteria);
  const unmet = verdict.criteria.filter(c => c.status !== "pass");
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
    "What was attempted, in order:",
    summarizeAttemptLog(attempts),
    ...(allowedCommandsOffered(attempts) ? ["", `Commands you may run: ${allowedCommandsOffered(attempts)}`] : []),
    ...missingParameterHints(attempts),
    "",
    "Work out why (wrong command, wrong parameters, a tool error, a step not done, a misread fact) and fix it now by calling the tools. Do not just describe the fix -- do it.",
    "Actions listed as FAILED are denied for this retry. An action listed as ok may already have taken effect: check the current state before doing it again, and never repeat one that sends, creates, or deletes something.",
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
  "- Use the installed commands listed above when they fit; otherwise find one with --help (aux4 --help lists every group). A package name (scope/name) is not a command.",
  "- Never guess a command name. If a call returns \"Command not found\", run --help on its parent group (drop the last word) and use a command listed there, or look for another command that does the same thing.",
  "- Before first using a command that changes something, read its --help for the exact parameter names. Once a change succeeds, do not run it again.",
  "- Before anything that cannot be undone (sending, deleting, paying), first get the facts it depends on from the tools, then say in one sentence what they mean for the action (e.g. whether the time is free) and act on exactly that.",
  "- Before sending or submitting a message, re-read the tool results it depends on and make sure the message agrees with them.",
  "- If an action returns \"User aborted\", the requester declined it: stop and say so, do not retry it.",
  "- Anything you send must name what it refers to (the item, the date and time), not just \"that\".",
  "- Never make up a value (an id, a code, a number, a name): use only values the request gives or a tool returned. If a required value cannot be found, do not submit or send -- say exactly what is missing.",
  "- Never ask the requester for something the tools can find out (a date, an id, a name): look it up. If a question is ambiguous, answer with the reading the results best support and say which."
].join("\n");

// Small models often cannot find a command three or four groups deep, so the
// harness looks up which installed commands fit the request (and each planned
// step) with `aux4 aux4 pkger find`, the same search the agent is told to use,
// and lists them. Commands of the agent itself are left out.
const FIND_LIMIT = 6;
const FIND_TIMEOUT_MS = 20000;
const MAX_FOUND = 8;

// A URL is not a word the docs use: it is searched as "web page". Scores from
// different queries do not compare, so results are merged by rank: every
// query's best match first, then every query's second, and so on.
export function findQuery(text) {
  return String(text || "").replace(/https?:\/\/\S+/gi, "web page").trim().slice(0, 300);
}

export function findCommands(queries) {
  const lists = [];
  for (const query of queries.map(findQuery).filter(Boolean)) {
    const result = runAux4(["aux4", "pkger", "find", "--query", query, "--limit", String(FIND_LIMIT)], { allowFailure: true, timeout: FIND_TIMEOUT_MS });
    const list = parseJSONLoose(result.stdout, []);
    if (!Array.isArray(list)) continue;
    lists.push(list
      .map(item => ({ command: String(item?.command || "").trim(), description: String(item?.description || "") }))
      .filter(item => item.command && !/^aux4 (ai agent|agent ask|aux4 pkger)(\s|$)/.test(item.command)));
  }
  const found = new Map();
  for (let rank = 0; rank < FIND_LIMIT && found.size < MAX_FOUND; rank++) {
    for (const list of lists) {
      const item = list[rank];
      if (item && !found.has(item.command)) found.set(item.command, item);
      if (found.size >= MAX_FOUND) break;
    }
  }
  return [...found.values()];
}

// Each command is written as the executeAux4 call that runs it: a small model
// shown a bare "aux4 agent browser find" tends to call it as a tool of that
// name, which no parser accepts, and the turn comes back empty.
// Command search works on short phrases about what a command does ("read email
// in the inbox"); a whole task sentence pulls in commands that merely share a
// word with it ("order" -> a todo list's order). The plan's lookFor phrases are
// searched when there are any; otherwise the request and its steps.
export function lookupQueries(request, plan) {
  const lookFor = Array.isArray(plan?.lookFor) ? plan.lookFor.filter(Boolean) : [];
  return lookFor.length ? lookFor : [request, ...(plan?.steps || [])];
}

export function describeFoundCommands(found) {
  if (!found.length) return "";
  return [
    "Installed aux4 commands that may fit -- run them through the executeAux4 tool:",
    ...found.map(f => `- executeAux4 {"command": "${f.command} --help"}${f.description ? ` -- ${f.description.split("\n")[0].slice(0, 100)}` : ""}`)
  ].join("\n");
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
    note: "Web pages: use aux4 agent browser run / aux4 agent browser find -- they open, read, fill and click for you. Direct aux4 browser commands are not available to you."
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
// failed commands, never globs).
export function addDenyPatterns(policyJSON, patterns) {
  const policy = parseJSONLoose(policyJSON, {}) || {};
  if (!patterns.length) return JSON.stringify(policy);
  const deny = Array.isArray(policy.deny) ? [...policy.deny] : [];
  const existing = new Set(deny.flatMap(entry => entry?.executeAux4 || []));
  const fresh = patterns.filter(p => !existing.has(p));
  if (fresh.length) deny.push({ executeAux4: fresh });
  return JSON.stringify({ ...policy, deny });
}

export function mergeDenyPolicy(policyJSON, failedCommands) {
  const policy = parseJSONLoose(policyJSON, {}) || {};
  if (!failedCommands.length) return JSON.stringify(policy);
  const deny = Array.isArray(policy.deny) ? [...policy.deny] : [];
  const existing = new Set();
  for (const entry of deny) {
    for (const pattern of entry?.executeAux4 || []) existing.add(pattern);
  }
  const fresh = [...new Set(failedCommands)].filter(cmd => cmd && !cmd.includes("*") && !existing.has(cmd));
  if (fresh.length) deny.push({ executeAux4: fresh });
  return JSON.stringify({ ...policy, deny });
}

// --- Stop conditions --------------------------------------------------------

export function sameFailureShape(a, b) {
  if (!a || !b) return false;
  const key = verdict => verdict.criteria
    .filter(c => c.status !== "pass")
    .map(c => `${c.criterion}::${c.status}`)
    .sort()
    .join("|");
  return key(a) === key(b);
}

// When a denied command came back with the list of commands that may run, the
// agent is not blocked: it has not yet tried what it is allowed to use.
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
  return text.trim().toUpperCase().startsWith(BLOCKED_MARK) || extractFailureClass(text) === "blocked";
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
  return String(text || "").replace(/^\s*FAILURE_CLASS:\s*[a-z_]+\s*\n?/gim, "").replace(/^\s*BLOCKED:\s*/i, "").trim();
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

  let deniedCommands = [];
  let priorVerdict = null;
  let lastContent = "";
  let lastVerdict = null;
  let pushedPastBlocked = false;
  let lookFirst = false;
  let confirmOpen = false;
  let commitGranted = false;
  let nextQuestion = "";
  const priorCommands = new Set();
  const done = (stopped, attempt, note = "") => {
    metrics.stopped = stopped;
    metrics.total = [metrics.plan, ...metrics.rounds.flatMap(r => [r.execute, r.verify || {}])]
      .reduce((acc, s) => addStats(acc, s), {});
    saveMetrics(history, metrics);
    return {
      content: appendStatusNote(stripFailureClass(lastContent), note),
      plan,
      verdict: lastVerdict,
      stopped,
      attempts: attempt,
      metrics
    };
  };

  for (let attempt = 1; attempt <= RETRY_BUDGET + 1; attempt++) {
    // The two-step note describes the fallback gate only; with tool-call hooks
    // nothing is held, and telling the agent otherwise sends it round in circles.
    const notes = [...(options.delegations || []).map(d => d.note), ...(options.hooksSupported ? [] : [CONFIRM_NOTE])].join("\n");
    const question = nextQuestion ? nextQuestion : attempt === 1
      ? composeExecuteQuestion(options.request, plan, recovery, describeFoundCommands(findCommands(lookupQueries(options.request, plan))), notes)
      : onlyAnswerFailed(plan, priorVerdict, extractAttemptLog(history))
        ? composeRewriteQuestion(priorVerdict)
        : composeDiagnoseQuestion(plan, priorVerdict, extractAttemptLog(history), options.request, lookFirst);

    const before = extractAttemptLog(history).length;
    const messagesBefore = readMessages(history).length;
    const usageBefore = readTokenUsage(history);
    const executeStart = Date.now();
    nextQuestion = "";
    // The gate opens for one round only: a later irreversible step is held again.
    // When ai-agent supports hooks (HARN-030), the confirmation is checked
    // in-round by its own `before` hook instead -- there is nothing left for
    // this permission-level gate to do, so it never denies the call.
    const gateOpen = confirmOpen || options.hooksSupported;
    confirmOpen = false;
    options.gateDeny = gateOpen ? [] : [CONFIRM_PATTERN];
    lastContent = execute(question, history, deniedCommands, attempt > 1);
    const round = { attempt, execute: { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart } };
    metrics.rounds.push(round);
    // One push per round, straight away (cheaper than verifying a round that
    // did nothing): a question asked without looking, or a step described or
    // written out as text instead of carried out.
    if (!isBlocked(lastContent)) {
      const push = askedWithoutLooking(lastContent, round.execute.toolCalls) ? LOOK_BEFORE_ASKING
        : describedWithoutDoing(lastContent, round.execute.toolCalls) ? DO_IT_NOW : "";
      if (push) {
        if (push === DO_IT_NOW) dropTrailingTextCall(history);
        lastContent = execute(push, history, deniedCommands);
        round.execute = { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart, pushed: push === DO_IT_NOW ? "do-it-now" : "look-first" };
      }
    }

    if (isBlocked(lastContent)) {
      const offered = !pushedPastBlocked && allowedCommandsOffered(extractAttemptLog(history));
      if (!offered) return done("blocked", attempt);
      pushedPastBlocked = true;
      lastContent = execute(composeNotBlockedQuestion(offered), history, deniedCommands);
      round.execute = { ...historyStats(history, messagesBefore, usageBefore), ms: Date.now() - executeStart };
      if (isBlocked(lastContent)) return done("blocked", attempt);
    }

    const attempts = extractAttemptLog(history);
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

    const verifyStart = Date.now();
    lastVerdict = runVerify(options, plan, lastContent, attempts, verifyHistoryPath(history, attempt));
    round.verify = { ...historyStats(verifyHistoryPath(history, attempt)), ms: Date.now() - verifyStart };
    saveVerdict(history, attempt, attempts, { ...lastVerdict, ms: { execute: verifyStart - executeStart, verify: Date.now() - verifyStart } });

    if (lastVerdict.overall === "pass") return done("pass", attempt);
    // No progress means the verdict did not move AND the round tried nothing
    // new; a retry that tried a different action is still making progress.
    const triedSomethingNew = attempts.slice(before).some(a => !priorCommands.has(a.command));
    if (sameFailureShape(priorVerdict, lastVerdict) && !triedSomethingNew) return done("no-progress", attempt, incompleteNote(lastVerdict));
    for (const a of attempts) priorCommands.add(a.command);
    if (attempt > RETRY_BUDGET) return done("budget", attempt, incompleteNote(lastVerdict));

    priorVerdict = lastVerdict;
    lookFirst = askedWithoutLooking(lastContent, round.execute.toolCalls);
    const newlyFailed = attempts.filter(a => a.failed && !a.declined).map(a => a.command);
    // A change that already went through must not be repeated by a retry.
    const doneChanges = attempts.filter(a => !a.failed && CHANGE_VERB.test(a.command)).map(a => a.command);
    deniedCommands = [...new Set([...deniedCommands, ...newlyFailed, ...doneChanges])];
  }

  // Unreachable in practice (the loop above always returns), but keep a safe
  // fallback so the function never resolves to undefined.
  return done("budget", RETRY_BUDGET + 1);
}
