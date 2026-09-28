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
| `--output` | `text` for the traditional Markdown response, or `json` for a typed response envelope | `text` |
| `--presentation` | Explicit presentation override (`auto`, `markdown`, `markdown+inline-ui`, `markdown+app-proposal`, `update-existing-ui`) | `auto` |
| `--conversationContext` | Compact recent context used only by presentation routing | none |
| `--activeArtifact` | Active artifact metadata as JSON; a follow-up routes to `update-existing-ui` | none |
| `--playbookFolder` | Folder containing learned playbooks | `.agent/playbooks` |
| `--playbookThreshold` | Minimum JEV probability for automatic playbook replay | `0.15` |
| `--classifierThreshold` | Minimum JEV probability for a UI presentation; lower confidence falls back to Markdown | `0.55` |
| `--builderAdapter` | Builder transport for JSON UI responses: `local`, `cloud`, or `disabled` | `local` (env `AGENT_BUILDER_ADAPTER`) |
| `--builderVm` | Cloud builder VM name | `builder` (env `AGENT_BUILDER_VM`) |
| `--builderScope` | Cloud scope containing the builder VM | `AUX4_CLOUD_SCOPE` |
| `--builderApiUrl` | Cloud API URL | `https://api.aux4.cloud` (env `AUX4_CLOUD_API_URL`) |
| `--builderTimeoutMs` | Builder timeout, clamped to 1–300 seconds | `120000` |
| `--builderDecisions` | Answers keyed by prior decision id as a JSON object | none |
| `--builderBackends` | Backend package allow-list as a JSON array | none |

The internal harness installs `agent/skill-playbook` and owns its lifecycle. Before the model runs,
it calls `hook-before`; a confident, fully parameterized match is executed directly. When no safe
match exists, the normal agent runs. After completion, `hook-after` inspects the history and may
append a suggestion to save repeatable work. Hook or classifier failure never prevents the normal
agent response.

Use `--output json` when a client needs presentation metadata:

```bash
aux4 agent ask "keep a grocery list for milk and eggs" --output json
```

```json
{
  "version": 1,
  "content": "I created the grocery list.",
  "presentation": {
    "version": 1,
    "mode": "markdown+inline-ui",
    "source": "classifier",
    "confidence": 0.91,
    "reason": "jev-selected-known-candidate",
    "criterion": "benefit-from-manipulating-structured-state",
    "requiresBuilder": true
  },
  "artifacts": [
    {
      "id": "grocery-list",
      "kind": "aux4.app",
      "version": 1,
      "presentation": "inline",
      "ref": "builder://grocery-list",
      "title": "Groceries",
      "schema": {
        "type": "List",
        "props": {
          "field": "items"
        }
      },
      "state": {},
      "data": {
        "app": {},
        "package": {}
      }
    }
  ],
  "builder": {
    "status": "done"
  },
  "execution": {
    "source": "agent"
  }
}
```

`content` is always the accompanying Markdown response. The classifier chooses only one of the
known presentation modes; it never creates a schema or artifact. In JSON mode, a UI decision calls
the configured builder and accepts only its typed `aux4.app` artifact contract. Text output and
`markdown` decisions never call the builder.

The local adapter sends bounded JSON on stdin to `aux4 agent builder build`. The cloud adapter sends
the same payload to `aux4 cloud builder generate`, adding `--scope` and `--apiUrl` when configured. User
text is never interpolated into a shell command. The payload includes the request, compact context,
active artifact/ref, and caller decisions.

A `needs-decision` result preserves the partial artifact, appends a clear question to `content`, and
returns the typed decisions in `builder.decisions`. A timeout, malformed result, or failed command
keeps the Markdown response and returns only a non-secret `builder.code`. Updates keep the active
artifact's `id` and `ref`. An app proposal adds `deployment.status: proposal` and always requires
explicit confirmation; the harness never deploys it automatically.

### `agent route`

Classify presentation without running the agent:

```bash
aux4 agent route "keep a grocery list I can edit"
```

The command prints one JSON decision with these stable modes:

- `markdown` — written answers, research, summaries, and simple confirmations.
- `markdown+inline-ui` — editable collections, forms, tables, trackers, dashboards, and repeated interaction.
- `markdown+app-proposal` — a request to publish or deploy the experience as an app.
- `update-existing-ui` — a follow-up that modifies the active artifact.

An explicit `--presentation` wins first. A natural-language request for Markdown, an inline UI, or
an app wins next. An active artifact then selects `update-existing-ui`. Otherwise JEV ranks the four
known candidates using the request and compact conversation context. Missing JEV or confidence
below `--classifierThreshold` returns `markdown`.

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

The playbook skill is different: it is an installed harness dependency and its before/after hooks
run deterministically. The model does not need to remember to invoke them.

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
