# Release notes

## 4.0.4

- `ask` now always runs every execution turn through a generic plan -> execute -> verify ->
  retry loop (`lib/agent-loop.mjs`, driven by `lib/ask.mjs`); there is no opt-out flag.
  Measured on local Gemma 4 (4B and 26B, thinking off): every journey of the dojo suite passes
  on both, at 2-4 minutes per suite.
- Plan: one short call with no tools; at most 3 criteria, typed `answer` or `state`, in the
  request's own words.
- Verify: the harness re-reads the current state itself (re-running an already-successful
  command whose command words include a read verb and no change verb -- an allowlist, since
  the re-run skips ai-agent's ask/deny prompt -- chosen by word overlap with the criteria) and one short
  verifier call with no tools judges it, plus coverage and honesty checks. Cut-off verdicts
  are salvaged; reworded entries are matched by position.
- Retry: answer-only fixes rewrite the answer without acting; otherwise the retry acts with
  the unmet criteria, attempt log, offered allowed-command list and missing-parameter hints.
  Failed actions and completed changes are denied; retries run on a 10-call budget; no-progress
  only when nothing new was tried; a declined confirmation stops the loop; `BLOCKED:` marks a
  real block.
- One-shot pushes for asking without looking, narrating a step, or writing a tool call as text.
- `<history>.metrics.json`: per-phase model calls, tokens, tool calls, wasted calls, timings.
- Helper calls bind one argument-free tool and are capped at 90 seconds (a looping model can
  no longer hang a run).

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
