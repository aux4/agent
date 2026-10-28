import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, buildAskArgs } from "../lib/ask.mjs";

test("parseArgs reads --name value pairs and keeps empty values empty", () => {
  const o = parseArgs(["--configFile", "c.yaml", "--config", "", "--tools", "executeAux4", "--request", "do it"]);
  assert.deepEqual(o, { configFile: "c.yaml", config: "", tools: "executeAux4", request: "do it" });
});

test("buildAskArgs reproduces the plain ask call when nothing was denied", () => {
  const args = buildAskArgs({ configFile: "c.yaml", packageDir: "/pkg", tools: "executeAux4", bio: "{}" }, "h.json", "q");
  assert.deepEqual(args, ["ai", "agent", "ask", "--configFile", "c.yaml", "--autoCompact", "true", "--baseInstructions", "/pkg/instructions/agent.md", "--bio", "{}", "--tools", "executeAux4", "--history", "h.json", "--question", "q"]);
});

test("buildAskArgs layers denials and a retry budget onto the caller's policy", () => {
  const args = buildAskArgs({ configFile: "c.yaml", packageDir: "/pkg", policy: '{"budget":{"calls":25}}' }, "h.json", "q", ["x delete 1"], true);
  const policy = JSON.parse(args[args.indexOf("--policy") + 1]);
  assert.equal(policy.budget.calls, 10);
  assert.deepEqual(policy.deny, [{ executeAux4: ["x delete 1"] }]);
});

test("buildAskArgs carries generated same-target patterns into the retry policy", () => {
  const pattern = 'google calendar events create *--summary*"Vendor sync meeting"*';
  const args = buildAskArgs({ packageDir: "/pkg" }, "h.json", "retry", [], true, [pattern]);
  const policy = JSON.parse(args[args.indexOf("--policy") + 1]);
  assert.deepEqual(policy.deny, [{ executeAux4: [pattern] }]);
});

test("buildAskArgs adds the delegated deny patterns to the policy", () => {
  const args = buildAskArgs({ packageDir: "/p", delegatedDeny: ["browser", "browser *"] }, "h.json", "q");
  const policy = JSON.parse(args[args.indexOf("--policy") + 1]);
  assert.deepEqual(policy.deny, [{ executeAux4: ["browser", "browser *"] }]);
});
