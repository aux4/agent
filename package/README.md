# agent/agent

AI agent with research, planning, task management, and iterative execution powered by on-demand skills.

## Installation

```bash
aux4 aux4 pkger install agent/agent
```

## Quick Start

```bash
aux4 agent start
aux4 agent ask "create a Python REST API with Flask"
aux4 agent stop
```

## Commands

### `agent start`

Bring the agent to life. Starts the background services (queue and cron) and schedules a recurring **heartbeat** so the agent wakes on its own, checks its goal and task board, and does the next thing that serves the goal — or rests if there is nothing to do. Must be called before using `agent ask` interactively.

```bash
aux4 agent start [--heartbeat <interval>] [--queuePort <port>]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--heartbeat` | How often the agent wakes to check its goal and task board (e.g. `5m`, `30s`, `1 hour`) | `5m` (env `AGENT_HEARTBEAT`) |
| `--queuePort` | Queue server port | `8420` (env `QUEUE_PORT`) |

The heartbeat is a `cron` task named `agent-heartbeat` that wakes the agent **directly** via `aux4 agent ask` — no UI connector or messenger is involved, so the agent lives fully headless. Each tick sends the prompt *"Heartbeat: check your goal and task board; do the next thing that serves the goal, or rest."* The base discipline makes the agent check its board first and rest cheaply when nothing is pending.

**Note:** the heartbeat wakes the agent on every tick, idle or not. A clean follow-up is a `todo` pending/assignee filter so the heartbeat can run a cheap, no-LLM pre-check and skip the wake when the agent has no incomplete tasks — making idle truly zero-cost.

### `agent stop`

Put the agent to rest. Symmetric with `agent start`: removes the `agent-heartbeat` cron and stops the queue. No connector involved.

```bash
aux4 agent stop [--queuePort <port>]
```

### `agent ask`

Send a request to the agent.

```bash
aux4 agent ask "<request>" [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `<request>` | The task or request to process | (required) |
| `--config` | Config section in `--configFile` to take the model from. Without it the agent falls back to the default model — which silently means the hosted one even when the section you named is local | (default model) |
| `--configFile` | Path to model configuration file | `config.yaml` or built-in |
| `--conversation` | Conversation name; each keeps its own history | `default` |
| `--instructions` | Path to custom instructions file | built-in |
| `--skills` | Path to skills directory | none |
| `--image` | Image file paths, comma-separated | none |
| `--tools` | Allow-list of tools to bind (e.g. `executeAux4,aux4Skill`); binding all tools can overwhelm a small model | all tools |
| `--policy` | Guardrails as JSON, e.g. `{"budget":{"calls":40}}` | unbounded |
| `--permissions` | Command allow-list as JSON, e.g. `{"allow":["aux4 google gmail list"]}`; confines the run | unrestricted |

#### The plan / verify / retry loop

Every `ask` always goes through a generic loop. There is no flag to turn it off:

1. **Plan.** One short call (no tools) fixes a `goal` and at most 3 `doneCriteria`, each typed
   `answer` (what the reply must say, agreeing with its source) or `state` (what must now be true
   outside the conversation). Criteria use the request's own words and never name a tool. A
   provisional `steps` list starts with finding, from the help, what provides each thing the
   request names. The plan includes separate read and write operations, such as checking a
   calendar and sending a reply. Saved as `<history>.plan.json`.
2. **Execute.** The normal agent run, told what done means plus a short block of working rules:
   find the command by matching the request's words to help text and allowed-command lists; read
   `--help` before the first use of a command that changes something; get the facts an
   irreversible action depends on first and state what they imply; stop if the requester declined
   a confirmation; name what a sent message refers to; look things up instead of asking. Browser
   goals identify the target from observed page data, name only requested fields, include the save
   or submit step, and stop after one successful save. A round that asked without using any tool,
   narrated a step, or wrote a tool call as text is pushed once straight away (a text-form call is
   removed from the history first). When tool hooks are available, outbound recipient addresses
   must appear exactly in the original request or a successful lookup. Before a command that
   changes state, a short check using the caller's configured model compares its target and values
   with the original request and observed facts, including exclusions. A denied or unparseable
   verdict prevents that command from running and tells the agent what evidence is missing.
3. **Verify.** For `state` criteria the harness reads the current state itself: it re-runs the
   already-successful command that shares the most words with the criteria, and only one whose
   command words include a read verb (get, list, show, view, search, ...) and no change verb.
   That re-run does not go back through ai-agent's runtime ask/deny prompt, which is why only
   commands that already ran successfully, and read, qualify. A single short verifier call (no tools) then judges
   every criterion against the request, the answer, each action's raw result, and that fresh
   read. Two criteria are always added: the answer covers every part of the request, and it
   describes what the actions actually did. A claim in the final answer alone cannot prove that
   something was sent, submitted, saved or changed; the write must have a successful action result
   or direct read-back evidence. With no read possible, `state` criteria are judged from the
   actions' own results; with no successful action at all, a `state` pass becomes
   `unverifiable`. A reply cut off mid-JSON is salvaged; an unparseable one is asked once more.
4. **Retry.** If anything is not a pass: when only `answer` criteria failed and any requested
   state change is supported by action evidence, the agent rewrites its answer without acting
   again; otherwise it gets the unmet criteria, the attempt log, any list of
   allowed commands a denial offered, and plain hints for aux4 missing-parameter errors, and must
   fix the problem by acting. If an inner run stops after identical results repeat, the harness
   verifies what it has and gives a bounded retry an alternate-action hint. Failed actions, and
   changes that already went through, are denied for the retry (`--policy` `deny`), and a retry
   runs on a 10-call tool budget.
5. **Stop.** On an all-pass verdict, a spent retry budget (2 retries), no progress (the same
   failure with nothing new tried), the requester declining a confirmation, or a `BLOCKED:` reply
   (only after the agent searched the help and any allowed-command list). Transient session IDs
   and confidence scores do not count as new results. Otherwise the answer says plainly what is
   not confirmed, and the harness label never reaches the requester.

Each run also writes `<history>.metrics.json`: model calls, tokens (input, cached, output), tool
calls, and the calls that bought nothing (failed, repeated, help lookups, empty replies) for the
plan, every execute round and every verify, with timings. The `actionChecks` entry records
pre-action model costs, which are included in the totals. Each check also saves its input,
model history and verdict alongside the conversation as `<history>.action-check-*` files.
Helper calls (plan, verdict) are capped at 90 seconds; a pre-action check is capped at 45 seconds.

### `agent new`

Start a new conversation. Saves the current session to the knowledge base, then clears the history.

```bash
aux4 agent new
```

### `agent resume`

Resume a paused agent session from the conversation history.

```bash
aux4 agent resume [options]
```

### `agent history`

View all past executions and their task lists.

```bash
aux4 agent history
```

## How the agent is composed

The agent's prompt is built from layers, lean by default:

1. **Base discipline** (`instructions/agent.md`, hardcoded and immutable) — a tight behavioral core: own your identity, hold opinions but verify facts against real tool calls, be **goal-oriented and self-directed** (on each wake, check your goal and task board first, work until done or blocked, then rest), clarify before acting, set a checkable definition of done, validate each done-condition against the actual artifact, report honestly. It carries no operational machinery — delegation, messaging, scheduling, and knowledge-base workflows live in on-demand skills, not in the base.
2. **Identity** (`bio:` in `config.yaml`) — who *this* agent is (name, role, description), injected into the base as an `# Agent Identity` section.
3. **AGENTS.md** (optional, picked up automatically) — what *this* agent does: its domain, task board, and persona.
4. **Skills** (optional `--skills` directory) — capabilities loaded only when a task needs them.

## Agent Identity (bio)

Define the agent's identity in a `bio:` section of `config.yaml`. The `ask` and `resume` commands read it and pass it to the runtime as `--bio`, which renders it into an `# Agent Identity` section on top of the base discipline. Recognized fields: `name`, `role`, `description`.

```yaml
config:
  bio:
    name: Sam Okafor
    role: infra engineer
    description: Owns the platform's CI/CD and observability; ships small reversible changes
```

If no `bio:` section is present, the agent still runs — no identity section is injected.

## Configuration

```yaml
config:
  model:
    type: bedrock
    model: global.anthropic.claude-sonnet-4-5-20250929-v1:0

  bio:
    name: Alex
    role: Senior Developer
    description: Handles code reviews, implements features, and manages deployments

  compaction:
    contextWindow: 200000
    maxContextPercent: 85
    keepLastMessages: 6
```
