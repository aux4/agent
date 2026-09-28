# Release notes

## Explicit separate collections bypass uncertain presentation classification

An unmistakable request such as `Create a separate picnic grocery list with juice and apples`
now selects inline UI before JEV classification. This narrow rule requires both explicit-new intent
and a mutable structured-state noun plus manipulation verb, so explanation and comparison requests
still use normal Markdown classification. It prevents a low-confidence classifier result from
turning an explicit new-list request into an unrelated destination question.

## Semantic artifact identity survives the harness boundary

Typed `aux4.app` artifacts now preserve optional deterministic `key` and bounded `aliases`
metadata from builder output through the JSON harness envelope. Strict validation rejects unsafe
keys, empty aliases, oversized aliases, and more than 16 aliases. Legacy artifacts without these
fields remain valid, and an update from an older builder inherits the active artifact's semantic
metadata while retaining its stable id/ref.

## Active artifacts reappear without regeneration

Pure requests such as “Show me the list”, “View the current dashboard”, and “Open it” now re-emit a
complete active `aux4.app` artifact directly. The harness preserves its identity, schema, state, and
data and returns concise Markdown without invoking classification, playbook hooks, the model, or the
builder. Mutation requests continue through the existing update path.

## Offline mutable-state routing and clean decision questions

When JEV is unavailable, the presentation router now recognizes conservative, obvious requests to
create or maintain mutable structured state—for example, “Keep a grocery list with milk and eggs”—
and selects inline UI. This fallback runs only when classification is unavailable; a valid low-score
classification still returns Markdown, and explanation/research requests are excluded.

Needs-decision answers now use a clean harness-authored question. Builder validation traces and
`--decide` instructions stay machine-readable under `builder.reason` instead of leaking into the
user-facing Markdown response.

## UI decisions now invoke the safe builder adapter

`agent ask --output json` now turns UI presentation decisions into typed `aux4.app` artifacts.
Local development calls `aux4 agent builder build`; deployed agents can select the cloud adapter to
call the `builder` VM. Both receive bounded JSON over stdin with no shell interpolation.

The Markdown response is always preserved. Needs-decision outcomes return a clear question and
machine-readable decisions, updates retain their artifact id/ref, and app proposals never deploy
without a later explicit confirmation. Timeouts, command failures, and malformed builder output
degrade safely to Markdown plus a non-secret error code.

The cloud builder command is `generate` (not `build`) so it does not collide with package build
commands installed on the command VM. The local developer command remains `agent builder build`.

## Internal harness: automatic playbooks and typed presentation routing

`agent/agent` now installs `agent/skill-playbook` and runs its before/after lifecycle in the harness,
so replay and learning no longer depend on a model following a prompt. Confident playbooks with all
parameters filled run directly; failed or unavailable matches fall through to the agent.

`agent route` emits a versioned JSON decision across four stable modes. `agent ask --output json`
includes that decision beside the Markdown `content`, an empty `artifacts` slot for builder/chat
integration, and execution metadata. Explicit requests and active artifacts are deterministic;
JEV handles the remaining choice and low confidence safely returns Markdown.

## `--config` now reaches the model

`aux4 agent ask --config <section>` passed a bare `--config` through to `ai agent ask`, so the
section name was dropped and the agent fell back to its default model. With a hosted key in the
environment that meant a run you intended to be local silently went to a hosted model instead —
succeeding, at hosted latency and cost, while looking local. The section name is now forwarded, so
`--config local26b` uses that section.

## `--permissions` to limit what the agent may run

`ask` accepts a `--permissions` allow-list (JSON), forwarded to the agent, so a run can be confined
to a named set of commands and kept away from anything else — useful for evals, cron jobs, and any
unattended run. Omitting it leaves the agent unrestricted, as before.

## `--tools` and `--policy` to bound a run

`ask` also forwards `--tools` (bind only the named tools instead of every tool) and `--policy`
(guardrails such as a call budget), so a run can be scoped and capped rather than left unbounded.
