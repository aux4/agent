#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

const BUILDER_LIMITS = {
  request: 16 * 1024,
  context: 32 * 1024,
  artifact: 64 * 1024,
  decisions: 32 * 1024,
  payload: 128 * 1024,
  output: 2 * 1024 * 1024,
  timeout: 300000
};

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

function parseOptionalJson(value, fallback, name) {
  if (!value || !String(value).trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function boundedString(value, max, name) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") > max) throw new Error(`${name} exceeds the builder payload limit`);
  return text;
}

function builderFailure(code) {
  return {
    status: "error",
    code,
    message: "I couldn't create or update the interactive view right now. The written response is still available."
  };
}

function makeBuilderPayload(options) {
  const currentArtifact = parseOptionalJson(options.activeArtifact, null, "activeArtifact");
  const decisions = parseOptionalJson(options.builderDecisions, {}, "builderDecisions");
  const backends = parseOptionalJson(options.builderBackends, [], "builderBackends");
  if (currentArtifact !== null && (Array.isArray(currentArtifact) || typeof currentArtifact !== "object")) {
    throw new Error("activeArtifact must be a JSON object");
  }
  if (!decisions || Array.isArray(decisions) || typeof decisions !== "object") {
    throw new Error("builderDecisions must be a JSON object");
  }
  if (!Array.isArray(backends)) throw new Error("builderBackends must be a JSON array");

  const request = boundedString(options.request, BUILDER_LIMITS.request, "request");
  const context = boundedString(options.conversationContext, BUILDER_LIMITS.context, "conversationContext");
  const artifactJson = currentArtifact === null ? "" : JSON.stringify(currentArtifact);
  const decisionsJson = JSON.stringify(decisions);
  if (Buffer.byteLength(artifactJson, "utf8") > BUILDER_LIMITS.artifact) throw new Error("activeArtifact exceeds the builder payload limit");
  if (Buffer.byteLength(decisionsJson, "utf8") > BUILDER_LIMITS.decisions) throw new Error("builderDecisions exceeds the builder payload limit");

  const hasCompleteArtifact = currentArtifact
    && currentArtifact.schema && typeof currentArtifact.schema === "object"
    && currentArtifact.data && typeof currentArtifact.data === "object"
    && currentArtifact.data.app && currentArtifact.data.package;

  const payload = {
    request,
    ...(context ? { context } : {}),
    ...(currentArtifact?.ref ? { currentRef: currentArtifact.ref } : {}),
    ...(hasCompleteArtifact ? { currentArtifact } : {}),
    ...(Object.keys(decisions).length ? { decisions } : {}),
    ...(backends.length ? { backends } : {}),
    auto: options.builderAuto !== "false",
    steps: Math.max(1, Math.min(50, Number.parseInt(options.builderSteps, 10) || 10)),
    ...(options.builderModel ? { model: options.builderModel } : {})
  };
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > BUILDER_LIMITS.payload) throw new Error("builder payload exceeds the total limit");
  return { payload, encoded };
}

function builderArgs(options) {
  if (options.builderAdapter === "local") return ["agent", "builder", "build"];
  if (options.builderAdapter === "cloud") {
    const args = ["cloud", options.builderVm || "builder", "generate"];
    if (options.builderScope) args.push("--scope", options.builderScope);
    if (options.builderApiUrl) args.push("--apiUrl", options.builderApiUrl);
    return args;
  }
  throw new Error("builderAdapter must be local, cloud, or disabled");
}

function parseBuilderOutput(stdout, activeArtifact = "") {
  let value;
  try {
    value = JSON.parse(String(stdout || "").trim());
  } catch {
    return builderFailure("BUILDER_INVALID_OUTPUT");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") return builderFailure("BUILDER_INVALID_OUTPUT");
  const { status, reason, artifact, artifactTransaction, decisions } = value;
  const hasArtifact = Object.prototype.hasOwnProperty.call(value, "artifact");
  const hasTransaction = Object.prototype.hasOwnProperty.call(value, "artifactTransaction");
  const typedArtifact = hasArtifact ? normalizeTypedArtifact(artifact) : null;
  const validTransaction = hasTransaction
    ? validateArtifactTransaction(artifactTransaction, activeArtifact)
    : false;
  if (status === "done" && hasArtifact !== hasTransaction && typedArtifact) {
    return { status, reason: typeof reason === "string" ? reason : "", artifact: typedArtifact };
  }
  if (status === "done" && !hasArtifact && validTransaction) {
    return {
      status,
      reason: typeof reason === "string" ? reason : "",
      artifactTransaction
    };
  }
  if (status === "needs-decision" && hasArtifact && !hasTransaction
    && typedArtifact && Array.isArray(decisions) && decisions.length > 0) {
    return { status, reason: typeof reason === "string" ? reason : "", artifact: typedArtifact, decisions };
  }
  if (status === "needs-input" && hasArtifact && !hasTransaction
    && typedArtifact && typeof reason === "string" && reason.trim()) {
    return { status, reason, artifact: typedArtifact };
  }
  return builderFailure("BUILDER_INVALID_OUTPUT");
}

function validSemanticKey(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/");
}

function validAliases(value) {
  return Array.isArray(value)
    && value.length <= 16
    && value.every(alias => typeof alias === "string"
      && alias.trim().length > 0
      && Buffer.byteLength(alias, "utf8") <= 96);
}

function normalizeTypedArtifact(artifact) {
  const validKey = artifact?.key === undefined || validSemanticKey(artifact.key);
  const aliasesValid = artifact?.aliases === undefined || validAliases(artifact.aliases);
  const validRevision = artifact?.revision === undefined
    || (Number.isInteger(artifact.revision) && artifact.revision > 0);
  const validArtifact = artifact && !Array.isArray(artifact) && typeof artifact === "object"
    && typeof artifact.id === "string" && artifact.id.length > 0
    && artifact.kind === "aux4.app"
    && artifact.version === 1
    && artifact.presentation === "inline"
    && typeof artifact.ref === "string" && artifact.ref.length > 0
    && typeof artifact.title === "string"
    && artifact.schema && !Array.isArray(artifact.schema) && typeof artifact.schema === "object"
    && artifact.state && !Array.isArray(artifact.state) && typeof artifact.state === "object"
    && artifact.data && !Array.isArray(artifact.data) && typeof artifact.data === "object"
    && validKey && aliasesValid && validRevision
    && artifact.data.app && !Array.isArray(artifact.data.app) && typeof artifact.data.app === "object"
    && artifact.data.package && !Array.isArray(artifact.data.package) && typeof artifact.data.package === "object";
  return validArtifact ? {
    id: artifact.id,
    kind: artifact.kind,
    version: artifact.version,
    presentation: artifact.presentation,
    ref: artifact.ref,
    title: artifact.title,
    ...(artifact.key !== undefined ? { key: artifact.key } : {}),
    ...(artifact.aliases !== undefined ? { aliases: [...artifact.aliases] } : {}),
    ...(artifact.revision !== undefined ? { revision: artifact.revision } : {}),
    schema: artifact.schema,
    state: artifact.state,
    data: artifact.data
  } : null;
}

function validateArtifactTransaction(transaction, activeArtifact) {
  if (!transaction || Array.isArray(transaction) || typeof transaction !== "object") return false;
  if (typeof transaction.transactionId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(transaction.transactionId)) return false;

  const source = transaction.source;
  if (!source || Array.isArray(source) || typeof source !== "object") return false;
  if (typeof source.id !== "string" || source.id.length === 0) return false;
  if (!Number.isInteger(source.revision) || source.revision <= 0) return false;
  if (source.ref !== undefined && (typeof source.ref !== "string" || source.ref.length === 0)) return false;
  if (source.key !== undefined && !validSemanticKey(source.key)) return false;

  let current;
  try {
    current = parseOptionalJson(activeArtifact, null, "activeArtifact");
  } catch {
    return false;
  }
  if (!current || Array.isArray(current) || typeof current !== "object") return false;
  if (current.id !== source.id || current.revision !== source.revision) return false;
  if (source.ref !== undefined && current.ref !== source.ref) return false;
  if (source.key !== undefined && current.key !== source.key) return false;

  const operations = transaction.operations;
  if (!Array.isArray(operations) || operations.length < 2) return false;
  const creates = operations.filter(operation => operation?.type === "create");
  const deletes = operations.filter(operation => operation?.type === "delete");
  if (creates.length < 1 || deletes.length !== 1 || operations.at(-1) !== deletes[0]) return false;
  if (operations.some(operation => !operation || (operation.type !== "create" && operation.type !== "delete"))) return false;
  if (deletes[0].id !== source.id || deletes[0].revision !== source.revision) return false;

  const keys = new Set();
  for (const operation of creates) {
    if (!validSemanticKey(operation.key) || !validAliases(operation.aliases)) return false;
    if (keys.has(operation.key)) return false;
    keys.add(operation.key);
    if (!normalizeTypedArtifact(operation.artifact)) return false;
    if (operation.artifact.key !== operation.key) return false;
    if (!Array.isArray(operation.artifact.aliases)
      || JSON.stringify(operation.artifact.aliases) !== JSON.stringify(operation.aliases)) return false;
  }
  return true;
}

function invokeBuilder(options) {
  if (options.builderAdapter === "disabled") return builderFailure("BUILDER_DISABLED");
  let encoded;
  let args;
  try {
    ({ encoded } = makeBuilderPayload(options));
    args = builderArgs(options);
  } catch (error) {
    if (/payload limit|total limit/.test(error.message)) return builderFailure("BUILDER_PAYLOAD_TOO_LARGE");
    return builderFailure("BUILDER_INVALID_INPUT");
  }

  const requestedTimeout = Number.parseInt(options.builderTimeoutMs, 10);
  const timeout = Math.max(1000, Math.min(BUILDER_LIMITS.timeout, Number.isFinite(requestedTimeout) ? requestedTimeout : 120000));
  const result = spawnSync(process.env.AUX4_BIN || "aux4", args, {
    encoding: "utf8",
    env: process.env,
    input: encoded,
    timeout,
    maxBuffer: BUILDER_LIMITS.output,
    killSignal: "SIGTERM"
  });
  if (result.error?.code === "ETIMEDOUT") return builderFailure("BUILDER_TIMEOUT");
  if (result.error?.code === "ENOBUFS") return builderFailure("BUILDER_OUTPUT_TOO_LARGE");
  if (result.error || result.status !== 0) return builderFailure("BUILDER_EXECUTION_FAILED");
  return parseBuilderOutput(result.stdout, options.activeArtifact);
}

function decisionQuestion(result) {
  const prompt = result.decisions.length === 1
    ? "I need one choice before I can finish the interactive view."
    : "I need a few choices before I can finish the interactive view.";
  const labels = result.decisions.map(decision => {
    if (typeof decision === "string") return decision;
    if (!decision || typeof decision !== "object") return "Choose one of the available options.";
    return String(decision.question || decision.label || decision.id || "Choose one of the available options.");
  });
  return `${prompt}\n\n${labels.map(label => `- ${label}`).join("\n")}`;
}

function inputQuestion() {
  return "I need a little more detail before I can finish the interactive view. Please describe the screen or interaction you want changed.";
}

function isContradictoryInteractiveProse(content) {
  const text = String(content || "").toLowerCase();
  return /(?:cannot|can't|do not have|don't have|unable to|not able to).{0,100}(?:custom|interactive|hosted|ui|widget|interface|web app)/.test(text)
    || /(?:capabilities|interface).{0,80}(?:limited to|only).{0,80}(?:text|specific tools)/.test(text)
    || /only (?:respond|reply) to (?:the )?text/.test(text);
}

function interactiveConfirmation(presentation) {
  return presentation.mode === "update-existing-ui"
    ? "I updated the interactive view."
    : "Here’s the interactive view.";
}

function brokeredFallbackArtifact(artifact, request) {
  if (!artifact || typeof artifact !== "object" || !artifact.id || !artifact.data) return null;
  const namespace = `artifact:${artifact.id}`;
  return {
    ...artifact,
    schema: {
      type: "Form",
      props: {
        onSubmit: `${namespace}:run`,
        submitLabel: "Run",
        fullWidth: true
      },
      children: [
        {
          type: "TextField",
          props: { field: "input", label: "Input", required: true, fullWidth: true }
        },
        {
          type: "Textarea",
          props: { field: "result", label: "Result", readOnly: true, minRows: 2, fullWidth: true },
          behaviors: [{ do: "show", when: { field: "result", is: "truthy" } }]
        }
      ]
    },
    state: { input: "", result: "" },
    data: {
      ...artifact.data,
      runtime: { version: 1, broker: "agent", actions: ["run"], request: String(request || "").slice(0, 16384) }
    }
  };
}

function genericBrokeredArtifact(request, conversation = "") {
  const suffix = createHash("sha256").update(`${String(conversation)}\n${String(request || "interactive-tool")}`).digest("hex").slice(0, 16);
  const id = `local/agent-action-${suffix}`;
  return brokeredFallbackArtifact({
    id,
    kind: "aux4.app",
    version: 1,
    presentation: "inline",
    ref: `builder://${id}`,
    title: "Interactive tool",
    schema: { type: "Page" },
    state: {},
    data: { source: "agent-action-broker" }
  }, request);
}

function applyStableArtifactIdentity(artifact, activeArtifact) {
  const current = parseOptionalJson(activeArtifact, null, "activeArtifact");
  if (!current || Array.isArray(current) || typeof current !== "object") return artifact;
  return {
    ...artifact,
    ...(current.id ? { id: current.id } : {}),
    ...(current.ref ? { ref: current.ref } : {}),
    ...(artifact.key === undefined && current.key ? { key: current.key } : {}),
    ...(artifact.aliases === undefined && Array.isArray(current.aliases) ? { aliases: [...current.aliases] } : {})
  };
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

function completeActiveArtifact(value) {
  if (!value || !String(value).trim()) return null;
  try {
    return normalizeTypedArtifact(JSON.parse(value));
  } catch {
    return null;
  }
}

function isActiveArtifactViewRequest(request) {
  const text = String(request || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/\b(?:add|append|remove|delete|update|edit|change|replace|rename|filter|sort|clear|complete|check|uncheck|deploy|publish|ship)\b/.test(text)) return false;
  if (/\b(?:markdown|plain text|text only|no ui|without (?:a |the )?ui|how to|how do|why|explain)\b/.test(text)) return false;

  const polite = "(?:(?:please |(?:can|could|would|will) you (?:please )?))?";
  const verb = "(?:show(?: me)?|view|open|display)";
  const determiner = "(?:(?:the|this|that|my|our|current|active) )?";
  const qualifier = "(?:(?:grocery|shopping|to-do|todo|task|packing|reading|guest|check) )?";
  const target = "(?:list|checklist|app|application|ui|interface|view|dashboard|form|table|tracker|artifact|it|this|that)";
  const namedList = "(?:(?:[a-z0-9-]+ ){0,4}(?:grocery|shopping|to-do|todo|task|packing|reading|guest|check) (?:list|checklist))";
  return new RegExp(`^${polite}${verb} ${determiner}(?:${namedList}|${qualifier}${target})(?: again| now| please)?$`).test(text);
}

function isExplicitNewMutableStateRequest(request) {
  const text = String(request || "").toLowerCase();
  return /\b(?:new|separate|another|additional|different|fresh|second)\b/.test(text)
    && inferObviousMutableStateMode(request) === "markdown+inline-ui";
}

function isRetryAfterInteractiveRefusal(request, conversationContext) {
  const retry = String(request || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^(?:try again|you can do it(?:,? try again)?|do it|go ahead|please try again|retry)$/.test(retry)) return false;
  const context = String(conversationContext || "").toLowerCase();
  return /(?:cannot|can't|do not have|don't have|unable to|not able to).{0,120}(?:custom|interactive|hosted|ui|widget|interface|web app)/.test(context)
    && /\b(?:custom|interactive|ui|widget|interface|form|input|button|web app)\b/.test(context);
}

function builderRequestFor(options) {
  if (!isRetryAfterInteractiveRefusal(options.request, options.conversationContext)) return options.request;
  const prior = String(options.conversationContext || "")
    .split(/\n+/)
    .map(line => line.replace(/^user:\s*/i, "").trim())
    .filter(line => line && !/^assistant:\s*/i.test(line))
    .filter(line => /\b(?:custom|interactive|ui|widget|interface|form|input|button|web app)\b/i.test(line));
  return prior.at(-1) || "Create the interactive UI requested earlier in this conversation.";
}

function inferExplicitMode(request, conversationContext = "") {
  const text = String(request || "").toLowerCase();
  if (/\b(markdown|plain text|text only|no ui|without (a |the )?ui)\b/.test(text)) return "markdown";
  if (/\b(make|turn|publish|deploy|ship)\b.{0,50}\b(app|application)\b|\b(app|application)\b.{0,50}\b(publish|deploy|ship)\b/.test(text)) {
    return "markdown+app-proposal";
  }
  if (/\b(inline|interactive)\b.{0,35}\b(ui|interface|widget|form|list|table|dashboard)\b|\b(show|display|render|build|create|give|make)\b.{0,80}\b(?:an?\s+)?(?:ui|interface|widget|form|input|field|web app)\b|\b(?:ui|interface|widget|form)\b.{0,80}\b(?:enter|input|type|zip code|field|button)\b/.test(text)) {
    return "markdown+inline-ui";
  }
  if (isExplicitNewMutableStateRequest(request)) {
    return "markdown+inline-ui";
  }
  if (isRetryAfterInteractiveRefusal(request, conversationContext)) {
    return "markdown+inline-ui";
  }
  return null;
}

function inferObviousMutableStateMode(request) {
  const text = String(request || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;

  // A response about a structured tool is still prose when the user is asking
  // to learn, compare, or draft. Keep these out of the offline UI fallback.
  if (/^(?:explain|describe|research|summarize|compare|review|write|draft|tell me|what |why |how )\b/.test(text)) {
    return null;
  }

  const mutableNoun = /\b(?:(?:grocery|shopping|to-?do|task|packing|reading|guest|check) list|checklist|tracker|inventory|kanban|dashboard|form|table|planner|budget|calendar|collection|board)\b/;
  const manipulation = /\b(?:keep|maintain|manage|track|organize|create|make|build|set up|start|give me|i (?:need|want)|add|remove|update|edit|record|log|show)\b/;
  return mutableNoun.test(text) && manipulation.test(text) ? "markdown+inline-ui" : null;
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

  const reusableArtifact = completeActiveArtifact(activeArtifact);
  if (reusableArtifact && isActiveArtifactViewRequest(request)) {
    return {
      version: 1,
      mode: "markdown+inline-ui",
      source: "active-artifact-reuse",
      confidence: 1,
      reason: "show-existing-active-artifact",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: false,
      reuseActiveArtifact: true
    };
  }

  const naturalOverride = inferExplicitMode(request, conversationContext);
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
    const deterministicMode = inferObviousMutableStateMode(request);
    if (deterministicMode) {
      return {
        version: 1,
        mode: deterministicMode,
        source: "deterministic-fallback",
        confidence: 1,
        reason: "obvious-mutable-structured-state-intent",
        criterion: "benefit-from-manipulating-structured-state",
        requiresBuilder: true
      };
    }
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
  const presentation = routePresentation(options);
  if (presentation.reuseActiveArtifact) {
    const artifact = completeActiveArtifact(options.activeArtifact);
    const content = /\b(?:list|checklist)\b/i.test(options.request) ? "Here’s the list." : "Here’s the current interactive view.";
    const envelope = {
      version: 1,
      content,
      presentation,
      artifacts: [artifact],
      execution: { source: "active-artifact-reuse" }
    };
    process.stdout.write(options.output === "json" ? `${JSON.stringify(envelope)}\n` : `${content}\n`);
    return;
  }

  const history = resolveHistory(options.conversation);
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
  if (options.output === "json" && presentation.requiresBuilder) {
    const builder = invokeBuilder({ ...options, request: builderRequestFor(options) });
    if (builder.status === "done") {
      if (builder.artifactTransaction) {
        envelope.artifactTransaction = builder.artifactTransaction;
        envelope.builder = { status: "done" };
      } else {
        const artifact = presentation.mode === "update-existing-ui"
          ? applyStableArtifactIdentity(builder.artifact, options.activeArtifact)
          : builder.artifact;
        envelope.artifacts = [artifact];
        envelope.builder = { status: "done" };
        if (isContradictoryInteractiveProse(envelope.content)
          && (presentation.mode === "markdown+inline-ui" || presentation.mode === "update-existing-ui")) {
          envelope.content = interactiveConfirmation(presentation);
        }
        if (isExplicitNewMutableStateRequest(options.request)) {
          envelope.content = /\b(?:list|checklist)\b/i.test(options.request)
            ? "Here’s your new list."
            : "Here’s your new interactive view.";
        }
        if (presentation.mode === "markdown+app-proposal") {
          envelope.deployment = { status: "proposal", automatic: false, requiresConfirmation: true };
        }
      }
    } else if (builder.status === "needs-decision" || builder.status === "needs-input") {
      const artifact = presentation.mode === "update-existing-ui"
        ? applyStableArtifactIdentity(builder.artifact, options.activeArtifact)
        : builder.artifact;
      const fallback = brokeredFallbackArtifact(artifact, options.request);
      if (fallback && presentation.mode === "markdown+inline-ui") {
        envelope.artifacts = [fallback];
        envelope.content = interactiveConfirmation(presentation);
        envelope.builder = { status: "done", fallback: "agent-action-broker" };
      } else {
        envelope.artifacts = [artifact];
        const question = builder.status === "needs-decision" ? decisionQuestion(builder) : inputQuestion();
        if (isContradictoryInteractiveProse(envelope.content)
          && (presentation.mode === "markdown+inline-ui" || presentation.mode === "update-existing-ui")) {
          envelope.content = interactiveConfirmation(presentation);
        }
        envelope.content = envelope.content ? `${envelope.content}\n\n${question}` : question;
        envelope.builder = builder.status === "needs-decision"
          ? { status: "needs-decision", reason: builder.reason, decisions: builder.decisions }
          : { status: "needs-input", reason: builder.reason };
      }
    } else {
      const fallback = presentation.mode === "markdown+inline-ui"
        ? genericBrokeredArtifact(options.request, options.conversation)
        : null;
      if (fallback) {
        envelope.artifacts = [fallback];
        envelope.content = interactiveConfirmation(presentation);
        envelope.builder = { status: "done", fallback: "agent-action-broker" };
      } else {
        envelope.content = envelope.content ? `${envelope.content}\n\n${builder.message}` : builder.message;
        envelope.builder = { status: "error", code: builder.code };
      }
    }
  }
  process.stdout.write(options.output === "json" ? `${JSON.stringify(envelope)}\n` : `${content}\n`);
}

function optionsFrom(values) {
  const [
    request = "", conversation = "", config = "", configFile = "config.yaml", instructions = "", skills = "",
    image = "", tools = "", policy = "", permissions = "", output = "text", presentation = "auto",
    conversationContext = "", activeArtifact = "", playbookFolder = ".agent/playbooks", playbookThreshold = "0.15",
    classifierThreshold = "0.55", classifyModel = "jev-1.13.0", classifyBaseUrl = "", classifyApiKey = "",
    brokerUrl = "", brokerToken = "", packageDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    builderAdapter = "local", builderVm = "builder", builderScope = "", builderApiUrl = "https://api.aux4.cloud",
    builderTimeoutMs = "120000", builderDecisions = "", builderBackends = "", builderAuto = "true",
    builderSteps = "10", builderModel = ""
  ] = values;
  return { request, conversation, config, configFile, instructions, skills, image, tools, policy, permissions, output,
    presentation, conversationContext, activeArtifact, playbookFolder, playbookThreshold, classifierThreshold,
    classifyModel, classifyBaseUrl, classifyApiKey, brokerUrl, brokerToken, packageDir, builderAdapter, builderVm,
    builderScope, builderApiUrl, builderTimeoutMs, builderDecisions, builderBackends, builderAuto, builderSteps, builderModel };
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
