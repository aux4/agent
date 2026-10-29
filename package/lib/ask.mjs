#!/usr/bin/env node
// `aux4 agent ask` entry point: every real execution turn runs inside the
// generic plan -> execute -> verify -> retry loop (lib/agent-loop.mjs). The
// .aux4 command resolves the history file, instructions, skills and flags;
// this file only drives the loop and makes each execution turn a normal
// `aux4 ai agent ask` call against the caller's own history.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runLoop, mergeDenyPolicy, addDenyPatterns, capRetryBudget, runAux4Monitored, activeDelegations, delegatedDenyPatterns,
  detectAiAgentHooksSupport, writeCheckValuesHooksFile
} from "./agent-loop.mjs";

// Flags arrive as `--name value` pairs; empty or missing values drop out.
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

// The same `aux4 ai agent ask` call the command made before the loop, with the
// caller's policy layered with the loop's denials (and a small budget on retries).
export function buildAskArgs(options, history, question, deniedCommands = [], retry = false, targetPatterns = []) {
  const args = ["ai", "agent", "ask", "--configFile", options.configFile || "config.yaml"];
  if (options.config) args.push("--config", options.config);
  args.push("--autoCompact", "true", "--baseInstructions", `${options.packageDir}/instructions/agent.md`);
  for (const name of ["bio", "instructions", "skills", "image", "tools", "permissions"]) {
    if (options[name]) args.push(`--${name}`, options[name]);
  }
  const delegated = options.delegatedDeny || [];
  const gate = options.gateDeny || [];
  if (options.policy || retry || deniedCommands.length || targetPatterns.length || delegated.length || gate.length) {
    const base = options.policy || "{}";
    const withDenials = mergeDenyPolicy(retry ? capRetryBudget(base) : base, deniedCommands, targetPatterns);
    // A delegated command's block says what to use instead.
    const reason = (options.delegations || []).map(d => d.note).filter(Boolean).join(" ");
    args.push("--policy", addDenyPatterns(addDenyPatterns(withDenials, delegated, reason), gate));
  }
  if (options.hooksFile) args.push("--hooks", options.hooksFile);
  args.push("--history", history, "--question", question);
  return args;
}

export async function main(argv) {
  const options = parseArgs(argv);
  options.delegations = activeDelegations();
  options.delegatedDeny = delegatedDenyPatterns(options.delegations);
  const history = options.history;
  // HARN-030: when the installed aux4/ai-agent supports tool-call hooks, use
  // one for the value-provenance check (agent-loop.mjs checkValuesHooksFile)
  // instead of the two-round confirmation gate -- same check, one round.
  options.hooksSupported = detectAiAgentHooksSupport();
  if (options.hooksSupported) {
    options.hooksFile = writeCheckValuesHooksFile(options.packageDir, history, options.request);
  }
  const execute = async (question, h, deniedCommands, retry = false, targetPatterns = []) => {
    const result = await runAux4Monitored(buildAskArgs(options, h, question, deniedCommands, retry, targetPatterns), h);
    if (result.budgetExceeded) {
      return {
        content: [result.stdout.trim(), "Execution stopped after the tool-call budget was exhausted."].filter(Boolean).join("\n"),
        stopReason: "budget"
      };
    }
    if (result.noProgress) {
      return {
        content: result.stdout.trim(),
        stopReason: "no-progress"
      };
    }
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || `aux4 exited ${result.status}${result.signal ? ` (${result.signal})` : ""}`;
      throw new Error(detail);
    }
    return result.stdout.trim();
  };
  const outcome = await runLoop(options, history, execute);
  process.stdout.write(`${outcome.content}\n`);
}

// Compare real paths: installed packages are often reached through symlinks.
function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
