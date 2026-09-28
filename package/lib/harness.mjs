#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MODES = [
  "markdown",
  "markdown+inline-ui",
  "markdown+app-proposal",
  "update-existing-ui"
];

const CANDIDATES = [
  {
    id: "markdown",
    text: "Return a normal written answer. Best for explanations, research, summaries, one-time confirmations, and requests that do not benefit from editable structured state after the response."
  },
  {
    id: "markdown+inline-ui",
    text: "Return written context plus an inline interactive UI. Best when the user benefits from repeatedly manipulating structured state such as a list, form, table, tracker, dashboard, calculator, or workflow."
  },
  {
    id: "markdown+app-proposal",
    text: "Return written context plus a proposal to turn the experience into a separately deployed application. Best when the user explicitly asks to make, publish, share, or deploy an app rather than only interact inline."
  },
  {
    id: "update-existing-ui",
    text: "Update the currently active interactive artifact. Best for a follow-up that changes, adds, removes, filters, or otherwise modifies state in an existing UI artifact."
  }
];

function runAux4(args, { allowFailure = false } = {}) {
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

function hasActiveArtifact(value) {
  if (!value || !String(value).trim()) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && (typeof parsed !== "object" || Object.keys(parsed).length > 0);
  } catch {
    return true;
  }
}

function inferExplicitMode(request) {
  const text = String(request || "").toLowerCase();
  if (/\b(markdown|plain text|text only|no ui|without (a |the )?ui)\b/.test(text)) return "markdown";
  if (/\b(make|turn|publish|deploy|ship)\b.{0,50}\b(app|application)\b|\b(app|application)\b.{0,50}\b(publish|deploy|ship)\b/.test(text)) {
    return "markdown+app-proposal";
  }
  if (/\b(inline|interactive)\b.{0,35}\b(ui|interface|widget|form|list|table|dashboard)\b|\b(show|build|create|give)\b.{0,35}\b(ui|interface|widget)\b/.test(text)) {
    return "markdown+inline-ui";
  }
  return null;
}

function fallback(reason, source = "fallback") {
  return {
    version: 1,
    mode: "markdown",
    source,
    confidence: 0,
    reason,
    criterion: "benefit-from-manipulating-structured-state",
    requiresBuilder: false
  };
}

function routePresentation({
  request,
  presentation = "auto",
  conversationContext = "",
  activeArtifact = "",
  classifierThreshold = "0.55",
  classifyModel = "jev-1.13.0",
  classifyBaseUrl = "",
  classifyApiKey = "",
  brokerUrl = "",
  brokerToken = ""
}) {
  if (presentation && presentation !== "auto") {
    if (!MODES.includes(presentation)) return fallback("invalid-explicit-mode");
    return {
      version: 1,
      mode: presentation,
      source: "explicit-override",
      confidence: 1,
      reason: "caller-selected-presentation",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: presentation !== "markdown"
    };
  }

  const naturalOverride = inferExplicitMode(request);
  if (naturalOverride) {
    return {
      version: 1,
      mode: naturalOverride,
      source: "explicit-request",
      confidence: 1,
      reason: "request-explicitly-selected-format",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: naturalOverride !== "markdown"
    };
  }

  if (hasActiveArtifact(activeArtifact)) {
    return {
      version: 1,
      mode: "update-existing-ui",
      source: "active-artifact",
      confidence: 1,
      reason: "follow-up-has-active-artifact",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: true
    };
  }

  const question = [
    "Choose the response presentation. The deciding question is: will the user benefit from manipulating structured state after this response?",
    `Current request: ${String(request || "").slice(0, 4000)}`,
    conversationContext ? `Recent context: ${String(conversationContext).slice(0, 4000)}` : ""
  ].filter(Boolean).join("\n");

  const args = [
    "classify", "rank", "--provider", "jev", "--question", question,
    "--blocks", JSON.stringify(CANDIDATES), "--top", "1"
  ];
  if (classifyModel) args.push("--model", classifyModel);
  if (classifyBaseUrl) args.push("--baseUrl", classifyBaseUrl);
  if (classifyApiKey) args.push("--apiKey", classifyApiKey);
  if (brokerUrl) args.push("--brokerUrl", brokerUrl);
  if (brokerToken) args.push("--brokerToken", brokerToken);

  try {
    const ranked = JSON.parse(runAux4(args).stdout);
    const best = Array.isArray(ranked.blocks) ? ranked.blocks[0] : null;
    const threshold = Number(classifierThreshold);
    if (ranked.scale !== "probability") return fallback("classifier-scale-not-probability");
    if (!best || !MODES.includes(best.id)) return fallback("classifier-returned-no-known-candidate");
    if (!Number.isFinite(best.score) || best.score < (Number.isFinite(threshold) ? threshold : 0.55)) {
      return fallback("classifier-confidence-below-threshold");
    }
    return {
      version: 1,
      mode: best.id,
      source: "classifier",
      confidence: best.score,
      reason: "jev-selected-known-candidate",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: best.id !== "markdown"
    };
  } catch {
    return fallback("classifier-unavailable");
  }
}

function parsePlaybookMatch(output) {
  const match = String(output || "").match(/^Playbook match:\s+([a-z0-9-]+)\s+\(confidence\s+([0-9.]+)\)/m);
  const run = String(output || "").match(/^Run: aux4 ai skill playbook run --id ([a-z0-9-]+) --params '([^\n]*)'$/m);
  if (!match || !run || match[1] !== run[1]) return null;
  try {
    const params = JSON.parse(run[2]);
    if (!params || Array.isArray(params) || typeof params !== "object") return null;
    if (Object.values(params).some(value => /^\{\{[^{}]+\}\}$/.test(String(value)))) return null;
    return { id: match[1], confidence: Number(match[2]), params };
  } catch {
    return null;
  }
}

function resolveHistory(conversation) {
  const name = conversation || "default";
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("conversation must contain only letters, numbers, dot, underscore, or dash");
  fs.mkdirSync(path.join(process.cwd(), ".agent", "history"), { recursive: true });
  return path.join(".agent", "history", `${name}.json`);
}

function getBio(configFile) {
  const result = runAux4(["config", "get", "--configFile", configFile, "--name", "bio"], { allowFailure: true });
  return result.ok && result.stdout.trim() ? result.stdout.trim() : "{}";
}

function runHookBefore({ request, folder, threshold, model, baseUrl, apiKey }) {
  const args = ["ai", "skill", "playbook", "hook-before", "--request", request, "--folder", folder, "--threshold", threshold, "--model", model];
  if (baseUrl) args.push("--baseUrl", baseUrl);
  if (apiKey) args.push("--apiKey", apiKey);
  const result = runAux4(args, { allowFailure: true });
  return result.ok ? parsePlaybookMatch(result.stdout) : null;
}

function runHookAfter({ request, history, folder, model, baseUrl, apiKey }) {
  const args = ["ai", "skill", "playbook", "hook-after", "--request", request, "--history", history, "--folder", folder, "--model", model];
  if (baseUrl) args.push("--baseUrl", baseUrl);
  if (apiKey) args.push("--apiKey", apiKey);
  const result = runAux4(args, { allowFailure: true });
  return result.ok ? result.stdout.trim() : "";
}

function runAgentAsk(options, history, recovery = "") {
  const args = ["ai", "agent", "ask", "--configFile", options.configFile || "config.yaml"];
  if (options.config) args.push("--config", options.config);
  args.push("--autoCompact", "true", "--baseInstructions", path.join(options.packageDir, "instructions", "agent.md"));
  args.push("--bio", getBio(options.configFile || "config.yaml"));
  const instructions = options.instructions || (fs.existsSync("AGENTS.md") ? "AGENTS.md" : "");
  const skills = options.skills || (fs.existsSync("skills") && fs.statSync("skills").isDirectory() ? "skills" : "");
  if (instructions) args.push("--instructions", instructions);
  if (skills) args.push("--skills", skills);
  if (options.image) args.push("--image", options.image);
  if (options.tools) args.push("--tools", options.tools);
  if (options.policy) args.push("--policy", options.policy);
  if (options.permissions) args.push("--permissions", options.permissions);
  const question = recovery ? `${options.request}\n\nA matched playbook was attempted but failed. Complete the request safely. Failure:\n${recovery.slice(0, 4000)}` : options.request;
  args.push("--history", history, "--question", question);
  return runAux4(args);
}

function ask(options) {
  const history = resolveHistory(options.conversation);
  const presentation = routePresentation(options);
  const match = runHookBefore({
    request: options.request,
    folder: options.playbookFolder,
    threshold: options.playbookThreshold,
    model: options.classifyModel,
    baseUrl: options.classifyBaseUrl,
    apiKey: options.classifyApiKey
  });

  let content = "";
  let execution = { source: "agent" };
  if (match) {
    const replay = runAux4([
      "ai", "skill", "playbook", "run", "--id", match.id,
      "--params", JSON.stringify(match.params), "--folder", options.playbookFolder
    ], { allowFailure: true });
    if (replay.ok) {
      content = replay.stdout.trim();
      execution = { source: "playbook", playbookId: match.id, confidence: match.confidence };
    } else {
      const failure = replay.stderr.trim() || replay.stdout.trim() || `exit ${replay.status}`;
      const agent = runAgentAsk(options, history, failure);
      content = agent.stdout.trim();
      execution = { source: "agent-after-playbook-failure", playbookId: match.id, confidence: match.confidence };
    }
  } else {
    content = runAgentAsk(options, history).stdout.trim();
  }

  const suggestion = runHookAfter({
    request: options.request,
    history,
    folder: options.playbookFolder,
    model: options.classifyModel,
    baseUrl: options.classifyBaseUrl,
    apiKey: options.classifyApiKey
  });
  if (suggestion) content = content ? `${content}\n\n${suggestion}` : suggestion;

  const envelope = {
    version: 1,
    content,
    presentation,
    artifacts: [],
    execution
  };
  process.stdout.write(options.output === "json" ? `${JSON.stringify(envelope)}\n` : `${content}\n`);
}

function optionsFrom(values) {
  const [
    request = "", conversation = "", config = "", configFile = "config.yaml", instructions = "", skills = "",
    image = "", tools = "", policy = "", permissions = "", output = "text", presentation = "auto",
    conversationContext = "", activeArtifact = "", playbookFolder = ".agent/playbooks", playbookThreshold = "0.15",
    classifierThreshold = "0.55", classifyModel = "jev-1.13.0", classifyBaseUrl = "", classifyApiKey = "",
    brokerUrl = "", brokerToken = "", packageDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  ] = values;
  return { request, conversation, config, configFile, instructions, skills, image, tools, policy, permissions, output,
    presentation, conversationContext, activeArtifact, playbookFolder, playbookThreshold, classifierThreshold,
    classifyModel, classifyBaseUrl, classifyApiKey, brokerUrl, brokerToken, packageDir };
}

const [action, ...values] = process.argv.slice(2);
try {
  if (action === "route") {
    const [request = "", presentation = "auto", conversationContext = "", activeArtifact = "", classifierThreshold = "0.55", classifyModel = "jev-1.13.0", classifyBaseUrl = "", classifyApiKey = "", brokerUrl = "", brokerToken = ""] = values;
    process.stdout.write(`${JSON.stringify(routePresentation({ request, presentation, conversationContext, activeArtifact, classifierThreshold, classifyModel, classifyBaseUrl, classifyApiKey, brokerUrl, brokerToken }))}\n`);
  } else if (action === "ask") {
    ask(optionsFrom(values));
  } else {
    throw new Error(`unknown action: ${action || "<empty>"}`);
  }
} catch (error) {
  process.stderr.write(`agent harness: ${error.message}\n`);
  process.exitCode = 1;
}
