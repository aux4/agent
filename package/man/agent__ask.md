#### Description

The `ask` command sends a request to the agent. The agent interprets the request, searches its knowledge base for context, executes the work, and reports results. If it needs clarification, it asks.

The agent runs on a tight, immutable base discipline (`instructions/agent.md`): own your identity, hold opinions but verify facts, clarify before acting, set a checkable definition of done, validate against the actual artifact, and report honestly. Operational machinery (delegation, messaging, scheduling) lives in on-demand skills, not the base.

The agent's identity is read from the `bio:` section of the config file (`name`, `role`, `description`) and injected into the base prompt as an `# Agent Identity` section. If no `bio:` is present, the agent runs without an identity section.

Every real execution turn always runs through a generic plan -> execute -> verify ->
retry loop; there is no flag to disable it. A short planning call (no tools) fixes a
`goal` and at most 3 typed `doneCriteria` -- `answer` (what the reply must say,
agreeing with its source) or `state` (what must now be true) -- in the request's own
words, saved as `<history>.plan.json`. The plan separately lists required reads and
writes, such as checking availability and sending a reply. The run gets those criteria plus a short block
of working rules, and a round that asked without looking, narrated a step, or wrote a
tool call as text is pushed once. To verify `state` criteria the harness re-runs the
already-successful command that best matches them, and only one whose command words
include a read verb (get, list, show, ...) and no change verb -- the re-run does not go
back through ai-agent's ask/deny prompt; one short verifier call, with no tools, judges every criterion, plus coverage
and honesty checks, from the request, the answer, the raw results and that read. A
claim in the final answer alone cannot prove that something was sent, submitted,
saved or changed; require a successful action result or direct read-back evidence.
On a miss the agent rewrites its answer (when only the answer was off and requested
state changes have action evidence) or retries with
the unmet criteria, the attempt log and hints. If an inner run stops after identical
results repeat, the harness verifies what it has and gives a bounded retry an
alternate-action hint. Failed actions and changes that
already went through are denied, and retries run on a 10-call budget. It stops on a
pass, 2 spent retries, no progress, a declined confirmation, or a `BLOCKED:` reply,
and says plainly what is not confirmed. Plans, verdicts and per-phase metrics (calls,
tokens, wasted calls, timings) are kept next to the history (`<history>.plan.json`,
`.verify.json`, `.metrics.json`).

The queue server must be running before executing this command.

#### Usage

```bash
aux4 agent ask "<request>" [--config <section>] [--configFile <path>] [--conversation <name>] \
  [--instructions <path>] [--skills <path>] [--image <paths>] \
  [--tools <list>] [--policy <json>] [--permissions <json>]
```

--request       The task or request to process (positional argument)
--config        Config section in --configFile to take the model from. Without it the agent falls back to the default model — which silently means the hosted one even when the section you named is local
--configFile    Path to model configuration file (default: config.yaml or built-in)
--conversation  Conversation name; each conversation keeps its own history
--instructions  Path to custom instructions file (default: built-in)
--skills        Path to skills directory (default: none)
--image         Image file paths, comma-separated
--tools         Comma-separated allow-list of tools to bind (e.g. `executeAux4,aux4Skill`). Binding every tool sends every tool description on each request; on a small model that context floor alone can stop it calling tools at all. Default: all tools
--policy        Guardrails as JSON, e.g. `{"budget":{"calls":40}}`. Without a budget a run is unbounded
--permissions   Command allow-list as JSON, e.g. `{"allow":["aux4 google gmail list"]}`. Confines the run to those commands; omit to leave it unrestricted

Configuration file:

```yaml
config:
  model:
    type: bedrock
    model: global.anthropic.claude-sonnet-4-5-20250929-v1:0

  bio:
    name: Sam Okafor
    role: infra engineer
    description: Owns the platform's CI/CD and observability; ships small reversible changes
```

#### Example

```bash
aux4 queue start &
aux4 agent ask "create a REST API for user management"
```
