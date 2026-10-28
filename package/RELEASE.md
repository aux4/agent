# Release notes

## 4.1.20

- A tool result whose own `next` step offers `confirm=yes` counts as the tool asking for the confirmation, whatever its status (agent/browser offered one with status "done").

## 4.1.19

- The "which item" check on confirmations only blocks an action that names one specific item
  the request does not pick out (4.1.16 applied the full same-round rule, including its strict
  verb match, to every confirmation and blocked legitimate form submits like "Submit" for "fill
  out the contact form").
- A confirmation is blocked while the tool reports empty fields in the form (`emptyFields`, from
  agent/browser >= 0.1.45): fill them from the request or a tool result, or ask the person.

## 4.1.18

- The original-request file is passed to the hook by absolute path: hook steps run from a scratch directory, so the relative path was never found and the hook fell back to the composed question.

## 4.1.17

- The value-check hook judges against the person's original request (written next to the history and passed as `--requestFile`), not the round's composed question, whose added criteria text ("- The order is cancelled") made an unspecific request look specific. A capitalised word at the start of a line no longer counts as a name.

## 4.1.16

- The value-check hook applies the "which item" rule to every confirmation, not only the harness's own same-round one: a confirm for an action that names one specific item the request does not pick out ("Cancel order ord-0001" for "please cancel my order") is blocked with a message to ask the person. Before, the agent itself confirmed it and an arbitrary order was cancelled.

## 4.1.15

- Same-round confirmation of an action that names one specific item ("Cancel order ord-0001", "Delete #123") now needs the request to say which item: that identifier, or details that pick one out (a number, a quoted value, a name; URLs do not count). "Cancel my order" names none, so the agent asks. Before, the verb and object type alone were enough and an arbitrary order was cancelled.

## 4.1.14

- A tool call that succeeds but reports its own work unfinished (`"status": "incomplete"`, `needs-input`, `error`, `blocked`, `failed`) no longer counts as finished work, so the retry is not a "only rewrite your answer" round. Before, the agent was told "the work itself is done" after a browser run returned incomplete, and it never retried the work.

## 4.1.13

- The delegation note (also the reason a blocked `browser ...` command gives) is written as the exact executeAux4 calls to make (`agent browser run --url <page> --goal "..."`, `agent browser find --url <page> --question "..."`). A small model read "use aux4 agent browser find" and dropped the "aux4 agent" part.

## 4.1.12

- A delegated command's block (e.g. `browser open` when agent/browser is installed) now tells the agent what to use instead (the delegation note, sent as the policy entry's reason; aux4/ai-agent >= 1.3.7). Before, a small model told only "Choose another approach" gave up on the page.

## 4.1.11

- A URL's scheme, host and port are no longer a source for an entered value: they are an
  address, not data the person gave. Before, an employee id "7400" was accepted because the
  page address was `http://127.0.0.1:7400/...`, and a registration was submitted with it. A
  URL's path and query still count (an id in a link is real data).

## 4.1.10

- A confirmation only answers a tool that stopped and asked for one: a call that confirms
  (`--field confirm=yes`, or `"confirm": "yes"`/`true` in `--data`) is blocked when no earlier
  result this round is waiting for a confirmation. Before, a "yes" passed on the first call was
  used by the browser for every irreversible click in the run (two orders were cancelled).
- Values passed as `--data` JSON are checked for made-up values exactly like `--field` values,
  and the no-hooks gate also holds a `--data` confirmation.

## 4.1.9

- Same-round confirmation is stricter: besides the action's verb, the object the action names
  ("Cancel order", "Delete account") must appear in the request. A shared verb with a different
  object ("cancel my newsletter" vs a page's "Cancel order #123") now asks instead of confirming.
- The yes/no-answer gate's share is a named constant (`LABEL_NAMED_SHARE`, 0.6, English word
  matching); stale hook comment corrected.

## 4.1.8

- Compacting a JSON tool result keeps each item's own short text (text, name, title, id...)
  from a list of objects instead of collapsing the list to "[n items]". 4.1.5 hid a page
  search's matching rows from the verifier, which then failed a correct answer and talked the
  agent out of it.
- The final output falls back to the last non-empty answer when the last round's reply is empty.

## 4.1.7

- A yes/no answer (yes, no, true, false, on, off, checked) for a choice the request itself names
  ("subscribe to product updates" -> `Subscribe to product updates=yes`) is the request's intent,
  not a made-up value, and is no longer blocked.
- The block message says "This call was NOT run" (it now fires on any browser call, not only a
  confirmation) and tells the agent to stop when the value cannot be found.

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
