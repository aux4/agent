#!/usr/bin/env node
// `aux4 agent ask` entry point: every real execution turn runs inside the
// generic plan -> execute -> verify -> retry loop (lib/agent-loop.mjs). The
// .aux4 command resolves the history file, instructions, skills and flags;
// this file only drives the loop and makes each execution turn a normal
// `aux4 ai agent ask` call against the caller's own history.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runLoop, mergeDenyPolicy, addDenyPatterns, capRetryBudget, runAux4, activeDelegations, delegatedDenyPatterns } from "./agent-loop.mjs";

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
export function buildAskArgs(options, history, question, deniedCommands = [], retry = false) {
  const args = ["ai", "agent", "ask", "--configFile", options.configFile || "config.yaml"];
  if (options.config) args.push("--config", options.config);
  args.push("--autoCompact", "true", "--baseInstructions", `${options.packageDir}/instructions/agent.md`);
  for (const name of ["bio", "instructions", "skills", "image", "tools", "permissions"]) {
    if (options[name]) args.push(`--${name}`, options[name]);
  }
  const delegated = [...(options.delegatedDeny || []), ...(options.gateDeny || [])];
  if (options.policy || retry || deniedCommands.length || delegated.length) {
    const base = options.policy || "{}";
    const withDenials = mergeDenyPolicy(retry ? capRetryBudget(base) : base, deniedCommands);
    args.push("--policy", addDenyPatterns(withDenials, delegated));
  }
  args.push("--history", history, "--question", question);
  return args;
}

export async function main(argv) {
  const options = parseArgs(argv);
  options.delegations = activeDelegations();
  options.delegatedDeny = delegatedDenyPatterns(options.delegations);
  const history = options.history;
  const execute = (question, h, deniedCommands, retry = false) =>
    runAux4(buildAskArgs(options, h, question, deniedCommands, retry)).stdout.trim();
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
