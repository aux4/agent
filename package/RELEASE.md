# Release notes

## 4.1.6

- The made-up-value check now runs on EVERY agent browser call that types values, not only on
  the confirmation call. Before, a value typed in one call and confirmed in a separate call
  (`--field 'confirm=yes'` alone) was never checked, and a made-up employee id was submitted.
- Confirming re-checks every value typed by earlier browser calls.
- A call that typed a value echoes it back in its own result; that echo no longer counts as the
  value's source (it made any made-up value look sourced once it had been typed).

## 4.1.5

- A tool's JSON result is compacted field by field (long strings shortened, short lists kept,
  nested data summarized) before it is cut to the 800-character size the attempt log and the
  verifier see. Before, one long field near the top (a confirmation message) pushed out the
  fields that mattered, such as the steps a browser run took, so the verifier could not see
  them, called the work unverifiable and retried, which resubmitted a form.
- The pending-confirmation check reads the attempt's full stored result, not the compacted one.

## 4.1.4

- Same-round confirmation for a clearly requested irreversible action (HARN-035). When a tool
  stops itself before an irreversible step and hands back a pending confirmation -- generically,
  a `next` command of its own carrying `--field 'confirm=yes'` (agent/browser's needs-input/
  confirm convention) -- the harness used to let the model end the round reporting that a
  confirmation was needed, fail verify ("not saved yet"), and only run `next` a whole retry
  round later. `runLoop` now decides, at the end of the execute round: if the request's own
  words contain the same change verb (`save`/`submit`/`book`/`confirm`/... -- the existing
  `CHANGE_VERB` classifier, now covering those verbs too) as the pending action's label, it is
  clearly requested -- the same round gets one short follow-up turn telling the executor to run
  `next` now, with the confirmation gate opened only for that one call, then verifies once.
  Anything short of that strict match -- the request says nothing about it, asks for a
  different change, or is genuinely ambiguous -- is never confirmed on a guess: the loop stops
  immediately with `stopped: "needs-confirmation"`, naming the exact pending action, and does
  not retry. The check-values before-hook (HARN-030) is untouched by this and keeps validating
  the follow-up confirm call exactly as any other.

## 4.1.3

- The check-values before-hook now passes the request, history and field values with `value()`
  instead of raw `"${__request}"`/`'${field}'`. aux4 runs a step as one shell line, so raw
  interpolation broke on ordinary text (a `(` in the history gave `Syntax error: "(" unexpected`
  and blocked a legitimate confirmation) and let request or tool-result text reach the shell.
  `value()` quotes each value, so nothing in it is ever interpreted.
- The harness read-back runs aux4 directly with no shell, splitting the command the same way
  executeAux4 does.

## 4.1.2

- Fixed the harness's own read-back (`runReadBack`, `lib/agent-loop.mjs`): the command recorded
  on an attempt is the executeAux4 tool's own bare argument -- never prefixed with `aux4` (that
  is also how policy deny patterns match it). Shelling that string out directly, as before,
  tried to run a program literally named e.g. `google` or `agent` and always failed silently, so
  `checks.length` was 0 on every round that depended on it -- across the whole dojo suite, every
  state criterion on a round with a change was downgraded to unverifiable and retried for no
  reason (26% of all input tokens went to retries; about half were false alarms this explains).
  `runReadBack` now runs `${AUX4_BIN or "aux4"} <command>`, matching `runAux4`.
- `requireOwnObservation` no longer downgrades a state criterion that asserts an absence of
  change ("no changes were made...", "nothing was submitted...", "without modifying...": see
  the new `isNoChangeCriterion`) when no change-verb command ran in the attempt -- the attempt
  log already proves it, with no need for a fresh look. A criterion with the same wording after
  a real change-verb command ran is still downgraded as before.
- `runLoop` gained a new stop condition, `unverifiableOnlyAfterChange`: when a round's unmet
  criteria are only unverifiable (nothing actually failed) and a change-verb command already
  succeeded this run, a retry could only repeat that command -- which is denied on every later
  round anyway -- for the same inconclusive verdict. The loop now stops there with the best
  answer it has (`stopped: "unverifiable-only"`) instead of spending a full execute round on it.

## 4.1.1

- The plan step could drop part of a request that named what a reply or message had to say
  (e.g. "reply telling them whether the time works"), keeping only the surrounding action
  ("a reply is sent"). A planner working to a 3-criteria cap then verified only that something
  was sent, not that it said the right thing -- so a reply could state the opposite of what an
  earlier tool result showed and still pass. `instructions/loop-plan.md` now tells the planner
  to give every distinct part of the request its own criterion (combine parts rather than
  dropping one).
- Added a fixed verify criterion, `AGREEMENT_CRITERION` (`lib/agent-loop.mjs`), checked on every
  run alongside the existing coverage and honesty checks: anything sent, submitted, or saved
  must state only facts that agree with what the tool results showed. This catches the case
  above even when the plan still under-specifies the content.
- `WORKING_RULES` gained one line: before sending or submitting a message, re-read the tool
  results it depends on and make sure the message agrees with them.

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
