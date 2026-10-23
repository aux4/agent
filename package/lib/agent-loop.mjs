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
const FAILURE_CLASSES = ["wrong_tool", "wrong_parameters", "tool_error", "incomplete", "misread_facts", "blocked"];

export function runAux4(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.env.AUX4_BIN || "aux4", args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024
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
  return runAux4(args, { allowFailure: true });
}

// --- Plan -------------------------------------------------------------

function normalizePlan(raw) {
  const goal = typeof raw?.goal === "string" && raw.goal.trim() ? raw.goal.trim() : "";
  const doneCriteria = Array.isArray(raw?.doneCriteria)
    ? raw.doneCriteria.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  const steps = Array.isArray(raw?.steps)
    ? raw.steps.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  return { goal, doneCriteria, steps };
}

export function fallbackPlan(request) {
  return {
    goal: String(request || "").trim(),
    doneCriteria: ["the request has been fully and correctly carried out"],
    steps: []
  };
}

export function buildPlan(options) {
  const result = askOnce(options, {
    instructions: planInstructionsPath(options.packageDir),
    question: `Request:\n${options.request}\n\nRespond with ONLY the JSON plan object described in your instructions. No prose, no code fences.`,
    extraArgs: sharedExtraArgs(options)
  });
  const parsed = parseJSONLoose(result.stdout, null);
  const plan = parsed ? normalizePlan(parsed) : fallbackPlan(options.request);
  if (!plan.goal) plan.goal = String(options.request || "").trim();
  if (plan.doneCriteria.length === 0) plan.doneCriteria = fallbackPlan(options.request).doneCriteria;
  return plan;
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
  return /^\s*error\b/i.test(text) || /⛔\s*policy denied/i.test(text);
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
        resultSummary: resultText.slice(0, 300)
      });
    }
  }
  return attempts;
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
  const criteria = doneCriteria.map(c => byCriterion.get(c) || { criterion: c, status: "unverifiable", evidence: "the verifier did not report on this outcome" });
  const overall = criteria.every(c => c.status === "pass") ? "pass" : "fail";
  return { overall, criteria };
}

export function fallbackVerdict(doneCriteria, reason) {
  return {
    overall: "fail",
    criteria: doneCriteria.map(c => ({ criterion: c, status: "unverifiable", evidence: reason }))
  };
}

export function runVerify(options, plan, finalAnswer, attempts) {
  const payload = {
    goal: plan.goal,
    doneCriteria: plan.doneCriteria,
    finalAnswer: String(finalAnswer || ""),
    attempts: attempts.map(a => ({ action: a.command, outcome: a.failed ? "error" : "ok", result: a.resultSummary }))
  };
  const question = `Evaluate this attempt and respond with ONLY the JSON verdict object described in your instructions.\n\n${JSON.stringify(payload, null, 2)}`;
  const result = askOnce(options, {
    instructions: verifyInstructionsPath(options.packageDir),
    question,
    extraArgs: sharedExtraArgs(options)
  });
  const parsed = parseJSONLoose(result.stdout, null);
  if (!parsed) return fallbackVerdict(plan.doneCriteria, "the verifier's output could not be parsed, so this outcome could not be confirmed");
  return normalizeVerdict(parsed, plan.doneCriteria);
}

// --- Diagnose + retry policy ----------------------------------------------

export function extractFailureClass(text) {
  const match = String(text || "").match(/FAILURE_CLASS:\s*([a-z_]+)/i);
  if (!match) return "";
  const value = match[1].toLowerCase();
  return FAILURE_CLASSES.includes(value) ? value : "";
}

export function composeDiagnoseQuestion(plan, verdict, attempts) {
  const failed = verdict.criteria.filter(c => c.status !== "pass");
  const lines = failed.map(c => `- ${c.criterion} (${c.status}): ${c.evidence}`).join("\n");
  return [
    "The previous attempt did not fully achieve the goal.",
    "",
    `Goal: ${plan.goal}`,
    "",
    "Outcomes not yet confirmed:",
    lines,
    "",
    "What was attempted, in order:",
    summarizeAttemptLog(attempts),
    "",
    "Do not repeat, unchanged, any action listed above as FAILED -- it has already been denied for this retry.",
    "",
    "First, on a line by itself, classify the failure as exactly one of:",
    "FAILURE_CLASS: wrong_tool",
    "FAILURE_CLASS: wrong_parameters",
    "FAILURE_CLASS: tool_error",
    "FAILURE_CLASS: incomplete",
    "FAILURE_CLASS: misread_facts",
    "FAILURE_CLASS: blocked",
    "",
    "Use \"blocked\" only when completing the goal needs information, access, or a decision only the requester can provide -- not simply because it is difficult.",
    "Then, below that line: if not blocked, revise your approach and act; if blocked, say exactly what you need from the requester and stop."
  ].join("\n");
}

export function composeExecuteQuestion(request, plan, recovery = "") {
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
    steps,
    recoveryNote
  ].join("\n");
}

export function mergeDenyPolicy(policyJSON, failedCommands) {
  const policy = parseJSONLoose(policyJSON, {}) || {};
  if (!failedCommands.length) return JSON.stringify(policy);
  const deny = Array.isArray(policy.deny) ? [...policy.deny] : [];
  const existing = new Set();
  for (const entry of deny) {
    for (const pattern of entry?.executeAux4 || []) existing.add(pattern);
  }
  const fresh = [...new Set(failedCommands)].filter(cmd => cmd && !existing.has(cmd));
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

export function isBlocked(executeOutput) {
  return extractFailureClass(executeOutput) === "blocked";
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
  const plan = buildPlan(options);
  savePlan(history, plan);

  let deniedCommands = [];
  let priorVerdict = null;
  let lastContent = "";
  let lastVerdict = null;

  for (let attempt = 1; attempt <= RETRY_BUDGET + 1; attempt++) {
    const question = attempt === 1
      ? composeExecuteQuestion(options.request, plan, recovery)
      : composeDiagnoseQuestion(plan, priorVerdict, extractAttemptLog(history));

    lastContent = execute(question, history, deniedCommands);

    if (isBlocked(lastContent)) {
      return { content: lastContent, plan, verdict: lastVerdict, stopped: "blocked", attempts: attempt };
    }

    const attempts = extractAttemptLog(history);
    lastVerdict = runVerify(options, plan, lastContent, attempts);

    if (lastVerdict.overall === "pass") {
      return { content: lastContent, plan, verdict: lastVerdict, stopped: "pass", attempts: attempt };
    }

    if (sameFailureShape(priorVerdict, lastVerdict)) {
      const note = incompleteNote(lastVerdict);
      return { content: appendStatusNote(lastContent, note), plan, verdict: lastVerdict, stopped: "no-progress", attempts: attempt };
    }

    if (attempt > RETRY_BUDGET) {
      const note = incompleteNote(lastVerdict);
      return { content: appendStatusNote(lastContent, note), plan, verdict: lastVerdict, stopped: "budget", attempts: attempt };
    }

    priorVerdict = lastVerdict;
    const newlyFailed = attempts.filter(a => a.failed).map(a => a.command);
    deniedCommands = [...new Set([...deniedCommands, ...newlyFailed])];
  }

  // Unreachable in practice (the loop above always returns), but keep a safe
  // fallback so the function never resolves to undefined.
  return { content: lastContent, plan, verdict: lastVerdict, stopped: "budget", attempts: RETRY_BUDGET + 1 };
}
