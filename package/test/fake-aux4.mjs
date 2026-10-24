#!/usr/bin/env node
// Stands in for `aux4` inside the loop: answers the plan and verify calls,
// and echoes the request an execution turn received, so a test can check
// that `aux4 agent ask` passes the request through intact.
const args = process.argv.slice(2);
const command = args.join(" ");
const question = args[args.indexOf("--question") + 1] || "";
if (command.includes("loop-plan.md")) {
  process.stdout.write(JSON.stringify({ goal: "g", doneCriteria: [{ text: "the reply repeats the request", kind: "answer" }], steps: [] }));
} else if (command.includes("loop-verify.md")) {
  const payload = JSON.parse(question.slice(question.indexOf("{")));
  process.stdout.write(JSON.stringify({ results: payload.criteria.map(c => ({ criterion: c.criterion, status: "pass", evidence: "ok" })) }));
} else {
  process.stdout.write(`REQUEST: ${question.split("\n")[0]}`);
}
