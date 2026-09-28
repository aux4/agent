# Release notes

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
