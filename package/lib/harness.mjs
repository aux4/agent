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

function builderReadyArtifact(artifact) {
  if (!artifact || artifact?.data?.source !== "agent-action-broker") return artifact;
  if (artifact.data.app && artifact.data.package) return artifact;
  if (!artifact.schema || Array.isArray(artifact.schema) || typeof artifact.schema !== "object") return artifact;

  const rawName = String(artifact.key || artifact.id || "interactive-view").toLowerCase();
  const name = rawName
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "interactive-view";
  const { source: _legacySource, ...builderData } = artifact.data;
  return {
    ...artifact,
    data: {
      ...builderData,
      app: { name: artifact.title || name, routes: { "/": artifact.schema } },
      package: { scope: "local", name }
    }
  };
}

function makeBuilderPayload(options) {
  const parsedArtifact = parseOptionalJson(options.activeArtifact, null, "activeArtifact");
  const currentArtifact = builderReadyArtifact(parsedArtifact);
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
  const { status, reason, artifact, artifactTransaction, artifactTransformation, decisions } = value;
  const hasArtifact = Object.prototype.hasOwnProperty.call(value, "artifact");
  const hasTransaction = Object.prototype.hasOwnProperty.call(value, "artifactTransaction");
  const hasTransformation = Object.prototype.hasOwnProperty.call(value, "artifactTransformation");
  const typedArtifact = hasArtifact ? normalizeTypedArtifact(artifact) : null;
  const validTransaction = hasTransaction
    ? validateArtifactTransaction(artifactTransaction, activeArtifact)
    : false;
  const validTransformation = hasTransformation
    ? validateArtifactTransformation(artifactTransformation, activeArtifact)
    : false;
  const resultCount = Number(hasArtifact) + Number(hasTransaction) + Number(hasTransformation);
  if (status === "done" && resultCount === 1 && hasArtifact && typedArtifact) {
    return { status, reason: typeof reason === "string" ? reason : "", artifact: typedArtifact };
  }
  if (status === "done" && resultCount === 1 && validTransaction) {
    return {
      status,
      reason: typeof reason === "string" ? reason : "",
      artifactTransaction
    };
  }
  if (status === "done" && resultCount === 1 && validTransformation) {
    return {
      status,
      reason: typeof reason === "string" ? reason : "",
      artifactTransformation
    };
  }
  if (status === "needs-decision" && hasArtifact && !hasTransaction && !hasTransformation
    && typedArtifact && Array.isArray(decisions) && decisions.length > 0) {
    return { status, reason: typeof reason === "string" ? reason : "", artifact: typedArtifact, decisions };
  }
  if (status === "needs-input" && hasArtifact && !hasTransaction && !hasTransformation
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
  const brokeredArtifact = artifact?.data?.source === "agent-action-broker"
    && artifact.schema && typeof artifact.schema === "object"
    && artifact.state && typeof artifact.state === "object";
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
    && (brokeredArtifact || (
      artifact.data.app && !Array.isArray(artifact.data.app) && typeof artifact.data.app === "object"
      && artifact.data.package && !Array.isArray(artifact.data.package) && typeof artifact.data.package === "object"
    ));
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

function validateArtifactTransformation(transformation, activeArtifact) {
  if (!transformation || Array.isArray(transformation) || typeof transformation !== "object") return false;
  const allowedKeys = new Set(["version", "transformationId", "mode", "source", "artifact"]);
  if (Object.keys(transformation).some(key => !allowedKeys.has(key))) return false;
  if (transformation.version !== 1) return false;
  if (typeof transformation.transformationId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(transformation.transformationId)) return false;
  if (transformation.mode !== "create" && transformation.mode !== "modify") return false;

  const artifact = normalizeTypedArtifact(transformation.artifact);
  if (!artifact) return false;
  if (transformation.mode === "create") {
    return transformation.source === undefined && artifact.revision === undefined;
  }

  const source = transformation.source;
  if (!source || Array.isArray(source) || typeof source !== "object") return false;
  const allowedSourceKeys = new Set(["id", "ref", "key", "revision"]);
  if (Object.keys(source).some(key => !allowedSourceKeys.has(key))) return false;
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
  const active = normalizeTypedArtifact(current);
  if (!active || active.id !== source.id || active.revision !== source.revision) return false;
  if (source.ref !== undefined && active.ref !== source.ref) return false;
  if (source.key !== undefined && active.key !== source.key) return false;
  if (artifact.id !== active.id || artifact.ref !== active.ref) return false;
  if (active.key !== undefined && artifact.key !== active.key) return false;
  if (artifact.revision !== active.revision) return false;
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
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "")
      .trim().replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
    console.error(`[agent-builder] execution failed status=${result.status ?? "error"}${detail ? ` detail=${detail}` : ""}`);
    return builderFailure("BUILDER_EXECUTION_FAILED");
  }
  const parsed = parseBuilderOutput(result.stdout, options.activeArtifact);
  const kind = parsed.artifactTransformation ? "transformation"
    : parsed.artifactTransaction ? "transaction" : parsed.artifact ? "artifact" : "none";
  console.error(`[agent-builder] response status=${parsed.status} kind=${kind}`);
  if (parsed.status === "error") {
    console.error(`[agent-builder] response rejected code=${parsed.code || "BUILDER_INVALID_OUTPUT"}`);
  }
  return parsed;
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

export function interactiveOperation(request) {
  const text = String(request || "").trim();
  const match = text.match(/(?:where|so)\s+(?:i|the user)\s+can\s+(?:enter|input|provide|choose|select)\s+(.+?)\s+and\s+(?:it\s+)?(?:shows?|returns?|displays?|calculates?|finds?)\s+(.+?)(?:[?.!]|$)/i);
  if (match) return `Given ${match[1].trim()}, return ${match[2].trim()}.`;
  return `Perform the non-UI operation implied by this request after the user submits the form: ${text}`.slice(0, 16384);
}

function zipListRequested(request) {
  const text = String(request || "");
  return /\bcit(?:y|ies)\b/i.test(text)
    && /\b(?:list|all|multiple|more than one|each|instead of|text\s*area|textarea)\b/i.test(text);
}

function zipCitiesList() {
  return {
    type: "Box",
    props: { border: true, radius: "md", padding: "sm", gap: 8 },
    // The empty result is intentionally hidden until the first lookup. A
    // zero-length array is truthy in JavaScript, so use an explicit flag.
    behaviors: [{ do: "show", when: { field: "citiesReady", is: "truthy" } }],
    children: [
      { type: "Label", props: { text: "Cities", size: "md", weight: "semibold" } },
      {
        type: "Repeat",
        props: { field: "cities", gap: 8, empty: "No cities found." },
        children: [{
          type: "Box",
          props: { background: "surface", border: true, radius: "sm", padding: "sm" },
          children: [{ type: "Label", props: { field: "name", size: "md" } }]
        }]
      }
    ]
  };
}

function interactivePresentation(request) {
  const text = String(request || "");
  // Treat both singular and plural wording as the ZIP lookup operation. The
  // update request commonly says “zip codes” and “cities”; missing the plural
  // form would silently fall back to the generic input/result artifact and
  // discard the existing ZIP handler.
  const zipToCity = /\b(?:zip|postal)\s*codes?\b/i.test(text) && /\bcit(?:y|ies)\b/i.test(text);
  if (zipToCity) {
    const multipleCities = /\b(?:possible|multiple|more than one|cities)\b/i.test(text);
    const listCities = zipListRequested(text);
    return {
      title: "ZIP Code Lookup",
      inputField: "zipCode",
      inputLabel: "ZIP code",
      inputPlaceholder: "e.g. 90405",
      outputField: listCities ? "cities" : "city",
      outputLabel: listCities || multipleCities ? "Cities" : "City",
      listCities,
      submitLabel: "Find city",
      handler: { type: "us-zip-city", timeoutMs: 8000 }
    };
  }
  return {
    title: "Interactive tool",
    inputField: "input",
    inputLabel: "Input",
    inputPlaceholder: "",
    outputField: "result",
    outputLabel: "Result",
    submitLabel: "Run",
    handler: null
  };
}

function brokeredPresentation(artifact, request) {
  const requested = interactivePresentation(request);
  if (requested.handler) return requested;

  const runtime = artifact?.data?.runtime || {};
  const identity = [artifact?.title, ...(Array.isArray(artifact?.aliases) ? artifact.aliases : [])]
    .filter(Boolean).join(" ").toLowerCase();
  const isZipArtifact = runtime.handler?.type === "us-zip-city"
    || /\b(?:zip|postal)\b/.test(identity)
    || /\bzip-code\b/.test(identity);
  if (!isZipArtifact) return requested;

  // A follow-up may describe the desired result (“show a list of cities”) without
  // repeating the original ZIP operation. Rebuild the brokered form from the
  // existing operation instead of dropping back to generic Input/Result fields.
  const children = Array.isArray(artifact?.schema?.children) ? artifact.schema.children : [];
  const fieldChild = field => children.find(child => child?.props?.field === field);
  const inputField = runtime.inputField === "zipCode" ? "zipCode" : "zipCode";
  const listCities = zipListRequested(request);
  const outputField = listCities ? "cities" : "city";
  const inputChild = fieldChild(runtime.inputField) || fieldChild("zipCode");
  const outputChild = fieldChild(runtime.outputField) || fieldChild("city");
  const multipleCities = /\bcit(?:y|ies)\b|\b(?:possible|multiple|more than one|list)\b/i.test(String(request || ""));
  return {
    title: "ZIP Code Lookup",
    inputField,
    inputLabel: "ZIP code",
    inputPlaceholder: inputChild?.props?.placeholder || "e.g. 90405",
    outputField,
    outputLabel: listCities || multipleCities ? "Cities" : outputChild?.props?.label || "City",
    listCities,
    submitLabel: "Find city",
    handler: { type: "us-zip-city", timeoutMs: 8000 }
  };
}

function brokeredFallbackArtifact(artifact, request) {
  if (!artifact || typeof artifact !== "object" || !artifact.id || !artifact.data) return null;
  const namespace = `artifact:${artifact.id}`;
  const presentation = brokeredPresentation(artifact, request);
  const output = presentation.listCities
    ? zipCitiesList()
    : {
      type: "TextArea",
      props: { field: presentation.outputField, label: presentation.outputLabel, readOnly: true, minRows: 2, fullWidth: true },
      behaviors: [{ do: "show", when: { field: presentation.outputField, is: "truthy" } }]
    };
  const currentState = artifact.state && typeof artifact.state === "object" && !Array.isArray(artifact.state)
    ? artifact.state
    : {};
  const listState = presentation.listCities
    ? {
      ...currentState,
      [presentation.inputField]: currentState[presentation.inputField] || "",
      cities: Array.isArray(currentState.cities) ? currentState.cities : [],
      citiesReady: Array.isArray(currentState.cities) && currentState.cities.length > 0
    }
    : { [presentation.inputField]: "", [presentation.outputField]: "" };
  return {
    ...artifact,
    schema: {
      type: "Form",
      props: {
        onSubmit: `${namespace}:run`,
        submitLabel: presentation.submitLabel,
        fullWidth: true,
        noSubmit: true,
        actionTimeoutMs: 27000
      },
      children: [
        {
          type: "TextField",
          props: {
            field: presentation.inputField,
            label: presentation.inputLabel,
            ...(presentation.inputPlaceholder ? { placeholder: presentation.inputPlaceholder } : {}),
            required: true,
            fullWidth: true
          }
        },
        {
          type: "Button",
          props: {
            label: presentation.submitLabel,
            onClick: `${namespace}:run`,
            fullWidth: true
          }
        },
        output
      ]
    },
    state: listState,
    data: {
      ...artifact.data,
      runtime: {
        version: 1,
        broker: "agent",
        actions: ["run"],
        request: String(request || "").slice(0, 16384),
        operation: interactiveOperation(request),
        inputField: presentation.inputField,
        outputField: presentation.outputField,
        ...(presentation.handler ? { handler: presentation.handler } : {})
      }
    }
  };
}

function genericBrokeredArtifact(request, conversation = "") {
  const suffix = createHash("sha256").update(`${String(conversation)}\n${String(request || "interactive-tool")}`).digest("hex").slice(0, 16);
  const id = `local/agent-action-${suffix}`;
  const presentation = interactivePresentation(request);
  return brokeredFallbackArtifact({
    id,
    kind: "aux4.app",
    version: 1,
    presentation: "inline",
    ref: `builder://${id}`,
    key: `agent-action:${suffix}`,
    title: presentation.title,
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
  if (/\b(?:add|append|remove|delete|update|edit|changes?|replace|rename|filter|sort|clear|complete|check|uncheck|deploy|publish|ship)\b|\b(?:instead of|not working|doesnt work|does not work)\b/.test(text)) return false;
  if (/\b(?:markdown|plain text|text only|no ui|without (?:a |the )?ui|how to|how do|why|explain)\b/.test(text)) return false;

  const polite = "(?:(?:please |(?:can|could|would|will) you (?:please )?))?";
  const verb = "(?:show(?: me)?|view|open|display)";
  const determiner = "(?:(?:the|this|that|my|our|current|active) )?";
  const qualifier = "(?:(?:grocery|shopping|to-do|todo|task|packing|reading|guest|check) )?";
  const target = "(?:list|checklist|app|application|ui|interface|view|dashboard|form|table|tracker|artifact|it|this|that)";
  const namedList = "(?:(?:[a-z0-9-]+ ){0,4}(?:grocery|shopping|to-do|todo|task|packing|reading|guest|check) (?:list|checklist))";
  return new RegExp(`^${polite}${verb} ${determiner}(?:${namedList}|${qualifier}${target})(?: again| now| please)?$`).test(text);
}

function isArtifactUpdateRequest(request) {
  const text = String(request || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /\b(?:new|separate|another|additional|different|fresh|second)\b/.test(text)) return false;
  const mutation = /\b(?:add|append|remove|delete|update|edit|changes?|replace|rename|filter|sort|clear|complete|check|uncheck|fix|improve|modify|adjust)\b|\b(?:instead of|not working|doesn?t work|does not work)\b/;
  const target = /\b(?:ui|interface|widget|form|view|app|application|artifact|list|checklist|dashboard|table|tracker|it|this|that)\b/;
  if (!mutation.test(text)) return false;
  if (target.test(text)) return true;

  // Short imperative state changes such as "add eggs" or "check milk"
  // refer to the active artifact through the conversation, even when the
  // request does not repeat "the list" or "the UI".
  return /^(?:add|append|remove|delete|complete|check|uncheck)\b/.test(text);
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

  // Mutation requests must win over the generic "show/build a form" heuristic.
  // Otherwise a request such as "update the UI" is classified as a fresh
  // markdown+inline-ui turn and the fallback creates a second artifact.
  if (hasActiveArtifact(activeArtifact) && isArtifactUpdateRequest(request)) {
    return {
      version: 1,
      mode: "update-existing-ui",
      source: "active-artifact",
      confidence: 1,
      reason: "request-updates-active-artifact",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: true
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

  // A view request against incomplete artifact metadata still needs the
  // builder to materialize the view. Only complete artifacts can be emitted
  // directly above; unrelated requests continue to the classifier below.
  if (hasActiveArtifact(activeArtifact) && isActiveArtifactViewRequest(request)) {
    return {
      version: 1,
      mode: "update-existing-ui",
      source: "active-artifact",
      confidence: 1,
      reason: "active-artifact-needs-materialization",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: true
    };
  }

  const question = [
    "Choose the response presentation. The deciding question is: will the user benefit from manipulating structured state after this response?",
    `Current request: ${String(request || "").slice(0, 4000)}`,
    conversationContext ? `Recent context: ${String(conversationContext).slice(0, 4000)}` : "",
    hasActiveArtifact(activeArtifact)
      ? "An active interactive artifact exists from an earlier turn. Reuse or update it only when the current request clearly refers to or changes that artifact; an unrelated question must remain a normal Markdown answer."
      : ""
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
    const mode = hasActiveArtifact(activeArtifact)
      && (best.id === "markdown+inline-ui" || best.id === "update-existing-ui")
      ? "update-existing-ui"
      : best.id;
    return {
      version: 1,
      mode,
      source: "classifier",
      confidence: best.score,
      reason: "jev-selected-known-candidate",
      criterion: "benefit-from-manipulating-structured-state",
      requiresBuilder: mode !== "markdown"
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
      } else if (builder.artifactTransformation) {
        envelope.artifactTransformation = builder.artifactTransformation;
        envelope.builder = { status: "done" };
      } else {
        const builtArtifact = presentation.mode === "update-existing-ui"
          ? applyStableArtifactIdentity(builder.artifact, options.activeArtifact)
          : builder.artifact;
        // Layout ownership stays inside builder. The harness only applies
        // stable identity; it never rewrites a successful builder artifact.
        const artifact = builtArtifact;
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
      // The builder's typed artifact is the UI response. Model prose generated
      // before the builder ran can contain speculative HTML/JS or describe a
      // layout that differs from the validated artifact. Never render that
      // implementation draft beside a successful inline UI result.
      if (presentation.mode === "markdown+inline-ui" || presentation.mode === "update-existing-ui") {
        envelope.content = interactiveConfirmation(presentation);
      }
    } else if (builder.status === "needs-decision" || builder.status === "needs-input") {
      const builtArtifact = presentation.mode === "update-existing-ui"
        ? applyStableArtifactIdentity(builder.artifact, options.activeArtifact)
        : builder.artifact;
      const artifact = builtArtifact;
      const fallback = brokeredFallbackArtifact(artifact, options.request);
      // A builder clarification is intentionally user-visible. Do not turn a
      // needs-input/needs-decision response for an existing artifact into a
      // new generic form; that loses the builder's requested context and makes
      // an update look like a replacement UI.
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
      const active = completeActiveArtifact(options.activeArtifact);
      const fallback = presentation.mode === "update-existing-ui"
        && builder.code !== "BUILDER_INVALID_OUTPUT"
        && active
        ? brokeredFallbackArtifact(active, options.request)
        : presentation.mode === "markdown+inline-ui"
          ? genericBrokeredArtifact(options.request, options.conversation)
          : null;
      if (fallback) {
        envelope.artifacts = [fallback];
        envelope.content = interactiveConfirmation(presentation);
        envelope.builder = { status: "done", fallback: "agent-action-broker", code: builder.code };
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
