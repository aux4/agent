# Release notes

## 4.1.56

- Preserve validated, incomplete ranked page candidates as positive provenance evidence without treating them as authorization or proof of absence.
- Stop repeating an identical hook-denied action when no new successful read facts have been observed; any new read facts allow a fresh authorization check.

## 4.1.55

- Retain bounded per-page ranked browser-find candidates alongside the unchanged global top-K, and normalize their score/order jitter while preserving newly surfaced page facts.

## 4.1.54

- Keep supplemental preset search results on the discovered service route, and include bounded live help from public ancestor groups so agents can discover relevant sibling commands.

## 4.1.53

- Add concise, bounded verifier evidence to failed or unconfirmed outcome summaries while preserving verified partial facts and suppressing unsupported executor claims.
- Stop retries when outcomes and evidence have not changed; ignore browser-find score/session/order jitter and seen subsets while recognizing newly observed rows and action targets.

## 4.1.52

- Anchor the bounded scoped-operation continuation to its returned session or observed URL. A per-call guard requires a successful fresh read there before any further change; the prompt excludes consumed target descriptors and confirmation values.
- Initialize the guard sidecar as inactive when writing hook files so callers that do not enter `runLoop` retain normal command behavior.

## 4.1.51

- Rebuild final output when any required criterion or guard check is failed, unknown, or missing; preserve verified partial facts and omit internal check labels.

## 4.1.50

- Build terminal summaries from verified state and answer criteria: preserve verified partial outcomes and verified answer facts, label failed versus unconfirmed outcomes, and omit unsupported executor claims. Fully passing answers remain unchanged.
- Allow one continuation from a scoped operation that explicitly reports an unverified goal and a changed fresh current observation. Re-observe the current page, use fresh controls, and keep the completed operation denied so it cannot be replayed.
- Include matched parent help alongside nested command help in command references.

## 4.1.49

- Separate scoped-operation completion receipts from goal verification. Use fresh current observations to assess every state criterion, honor contradictions, and require complete source coverage before claiming absence.

## 4.1.48

- Expose `agent browser inspect` as a deterministic page-read capability. State that completeness is limited to extracted blocks on the current rendered page and that ranked `find` matches are not an exhaustive result set.

## 4.1.47

- Give authorization checks explicit observed values and unchanged-value comparisons from independent unambiguous evidence.

## 4.1.46

- Clarify authorization of explicit open choices and resubmitted unchanged field values.

## 4.1.45

- Preserve explicit enable/disable directions before authorization.
- Allow registered delegates to inspect an unchanged original goal without adding data, controls, or substituted explicit URLs.

## 4.1.44

- Suppress false success claims when completion lacks execution evidence, while recognizing a recorded submission followed by a later incomplete step.

## 4.1.43

- Give malformed authorization replies one bounded re-evaluation while honoring valid denials; record both checks and require a valid boolean decision.
- Reject completion claims for state-changing criteria supported only by failed or unexecuted changes.

## 4.1.42

- Keep registered page delegation while discovering other capabilities needed by the plan, including independent prerequisite reads.
- Tell planning which operations the registered capability already covers, avoiding both hidden dependencies and redundant command references.

## 4.1.41

- Enforce explicitly preserved field values and reject already completed exact writes before model judgment.

- Validate delegated goals and staged values against the original request; distinguish assigned record values from available options and staged echoes.
- Share field provenance rules before and after actions, including named boolean choices and exclusion of failed, documentation, or model-summary sources.
- Preserve original authority and factual history across delegated field writes; pass concrete values to the browser guard through stdin before effects.

## 4.1.40

- Keep unsubmitted and waiting-input workflows eligible for continuation instead of denying their commands as completed changes.

## 4.1.39

- Keep pre-action evidence refusals pending across unrelated questions and documentation calls, so a non-interactive question cannot suppress lookup recovery.

## 4.1.38

- Preserve full request values and exclusions in delegated goals; recover missing required data before considering automatic confirmation.

## 4.1.37

- Surface installed child-command parameter names before verbose help, retaining command indexes for every discovered service.

## 4.1.36

- Treat filtered misses as limited evidence and allow one broader lookup before declaring absence; preserve observed zones in machine timestamps.

## 4.1.35

- Include installed parent lookup documentation when an outbound address is missing, keeping recovery focused on obtaining the prerequisite.
- Count unusable-provider-request repairs explicitly in model-call and protocol-error metrics.

## 4.1.34

- Require exact target identifiers from the request or prior successful results before existing-resource mutations; retain documented defaults and positional ID syntax.

## 4.1.33

- Reserve a compact child-command index for every discovered group before distributing detailed-help budget, keeping prerequisite lookups visible across services.
- Evaluate each proposed write as a valid step toward the request, allowing remaining authorized targets after earlier changes succeed.

## 4.1.32

- Provide bounded, deduplicated successful read evidence in recovery questions so retries can finish remaining work without rereading facts.

## 4.1.31

- Count local parameter-reference lookups in help metrics while preserving actual model and tool-call counts.

## 4.1.30

- Validate routing values against installed parameter documentation; resolve a contact name to an email address when the command requires one.

## 4.1.29

- Scope live retry monitoring to newly completed calls, so old refusals do not kill a recovery attempt.
- Allow help, new sources, and pending commands through repeated-read checks while retaining duplicate-evidence limits.

## 4.1.28

- Require exact outbound addresses from the request or successful reads; help examples and previous write echoes cannot establish a recipient.
- Check proposed writes against the original request and observed facts before execution, using the caller's configured model and recording each decision.
- Include the pre-action checks' model calls and tokens in run metrics.
- Plan prerequisite lookups for missing identifiers and addresses, and give an unresolved guard denial one bounded recovery before final verification.
- Route explicit page tasks to installed goal-level delegates before adding global command-search results to their context.
- Prioritize observed results and use the existing verification evidence budget across the actual number of actions, retaining concrete page facts and control states.

## 4.1.27

- Prioritize the deepest matched command groups and show their complete child paths before broader help consumes the command-reference budget.
- State that help is documentation and group headings must be completed with a child command before flags.
- Include a complete start-to-end range when reporting a timed item and both endpoints are available.

## 4.1.26

- Parse the installed-command search's colored text results so relevant commands are supplied to the agent before it starts exploring.
- Stop after a failed command search so a cold index is not rebuilt once per query phrase.

## 4.1.25

- Clarify that the goal-level browser command is available while raw browser commands are not, and direct page tasks to the end-to-end browser agent.
- Make command-group help, repeated identical lookup results, and preservation of unrequested record fields explicit in the working rules.

## 4.1.24

- Preserve mixed-case entity flags in same-target retry guards and stop retrying rejected options.
- Give hooks the raw command line so repeated-read checks can compare the actual calls.
- Delegate browser work as one end-to-end goal and verify the resulting state before reporting completion.

## 4.1.23

- A repeated-result stop now goes through verification and a bounded recovery round with an alternate-action hint instead of ending the whole task.
- Keep the interrupted execution's actual output for verification instead of appending a generic stop message to the answer.

## 4.1.22

- Recover an unresolved structured confirmation when later `confirm=yes` calls were blocked, limited to the current execution round.
- Require direct action or read-back evidence for requested state changes; an answer-only retry cannot hide an unsupported write.
- Planning and browser delegation now cover separate read/write operations, one scoped save, and evidence-based routes and identifiers.

## 4.1.21

- Retry rounds refuse a successful mutation against the same stable target, even when only cosmetic fields differ.

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
