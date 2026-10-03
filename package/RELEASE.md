# Release notes

## 4.2.35

- Emit a bounded diagnostic when a successful builder process returns a response that fails the typed response contract.

## 4.2.34

- Log a bounded, credential-redacted builder transport error when the cloud builder process exits unsuccessfully, so fallback updates can be diagnosed from VM logs.

## 4.2.33

- Remove the legacy broker-only `data.source` marker from the strict builder transport while preserving runtime actions and synthesized app/package documents.
- Prevent strict request decoding from rejecting upgraded brokered artifacts before layout planning.

## 4.2.32

- Upgrade legacy brokered inline artifacts to the builder's complete `aux4.app` input contract before requesting an update.
- Preserve the brokered runtime action metadata while adding deterministic app and package documents, allowing validated layout transformations to replace older fallback forms.

## 4.2.31

- Accept, validate, and forward the builder's typed `artifactTransformation` response.
- Preserve the complete validated transformation for the artifact authority instead of treating it as invalid builder output and falling back to an older locally generated form.

## ZIP city updates use a real list

Requests to show all cities for a ZIP code now replace the single output text area
with a display-only `Repeat` list. The harness enforces this schema change even when
a builder returns the prior artifact unchanged, and the agent action returns one
structured row per distinct city without creating an input control for each row.

## ZIP result field uses the registered component name

Brokered ZIP lookup forms now emit the registered `TextArea` schema type for the City output.
Successful lookups therefore have a real output control to display the returned city.

## Fallback forms carry a unique semantic key

Conversation-scoped brokered forms now carry their generated identity as a
semantic artifact key. The canonical store therefore does not collapse separate
forms onto the first generic “Interactive tool” title alias.

## Fallback artifact identity is conversation-stable

Generic brokered forms now include the conversation identity in their stable id.
The same UI request in a new conversation therefore creates a distinct canonical
artifact instead of conflicting with an older conversation's saved form.

## Builder outage fallback remains interactive

An explicit create-UI request now receives the same scoped agent-action form when
the configured builder is temporarily unavailable, not only when the builder
returns a partial artifact. The agent never repeats its text-only refusal while
the UI service is recovering.

## Runnable fallback artifacts

When a cloud builder returns a valid partial artifact because no installed backend
command matches the requested interaction, an explicit create-UI request now still
produces a runnable form. Its single scoped action is brokered by the owning agent,
so the form can perform the requested lookup or tool-backed operation without
inventing an uninstalled command or falling back to a text-only refusal.

## Recognize display-and-input UI requests

Requests phrased as “display a UI where I can enter…” now deterministically select the inline
builder path, including `display`, `render`, `input`, and `field` wording. This prevents the model's
text-only capability disclaimer from handling an explicit interactive request.

## Reconstruct the original UI request on short retries

When a user follows an earlier UI refusal with a short retry such as “You can do it, try again,”
the harness now sends the prior UI request—not the vague retry phrase—to the builder. This lets the
builder produce a renderable artifact while the chat still reflects the user's latest turn.

## Retry UI refusals through the builder

Short follow-ups such as “Try again” now inherit an earlier interactive-UI request when the
conversation context contains the agent's contradictory UI refusal. The presentation router then
selects the inline builder path instead of accepting another text-only refusal.

## Builder clarification responses remain interactive

A valid builder `needs-input` response now preserves its typed artifact, retains stable active
identity on updates, and asks the user for a clearer screen or interaction description. Internal
builder diagnostics remain machine-readable and no longer become a misleading technical-error
fallback.

## Named canonical views and atomic artifact transaction plans

Pure named view requests such as “Show my breakfast grocery list” now re-emit the complete resolved
active artifact without invoking the builder. Canonical revision metadata is retained with the
artifact's id, ref, semantic identity, schema, and state.

Builder results may now contain an `artifactTransaction` instead of one ordinary artifact. The
harness validates the active source identity and revision, transaction id, create artifacts,
semantic keys and aliases, and final matching delete, then passes the plan through unchanged with an
empty `artifacts` array. It never executes the transaction; the caller owns the atomic commit and
idempotent replay. Ambiguous or malformed plans fail through the existing safe builder error path.

## Successful separate collection builds use clean confirmation prose

When an explicit new/separate collection successfully produces an inline artifact, the harness now
returns `Here’s your new list.` instead of retaining a model-side destination question that the
completed UI has already answered. The artifact, state, and semantic identity remain unchanged.

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
