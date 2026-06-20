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
| `--configFile` | Path to model configuration file | `config.yaml` or built-in |
| `--instructions` | Path to custom instructions file | built-in |
| `--skills` | Path to skills directory | none |
| `--history` | Path to conversation history file | `manager-history.json` |
| `--memory` | Knowledge base folder | `.memory` |
| `--queuePort` | Queue server port | `8420` |

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
