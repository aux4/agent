#### Description

The `ask` command sends a request to the agent. The agent interprets the request, searches its knowledge base for context, executes the work, and reports results. If it needs clarification, it asks.

The agent runs on a tight, immutable base discipline (`instructions/agent.md`): own your identity, hold opinions but verify facts, clarify before acting, set a checkable definition of done, validate against the actual artifact, and report honestly. Operational machinery (delegation, messaging, scheduling) lives in on-demand skills, not the base.

The agent's identity is read from the `bio:` section of the config file (`name`, `role`, `description`) and injected into the base prompt as an `# Agent Identity` section. If no `bio:` is present, the agent runs without an identity section.

Conversation history is persisted per conversation under `.agent/history/<conversation>.json`. Use `--conversation` to select or start a named conversation; without it, the agent uses `.agent/history/default.json`. The history directory is created automatically. History grows as the conversation continues; `agent new` consolidates it into memory and clears it.

If `--instructions` is omitted, the agent picks up `AGENTS.md` from the current directory when present (domain instructions). If `--skills` is omitted, it picks up a `skills` directory from the current directory when present (on-demand capabilities).

#### Usage

```bash
aux4 agent ask "<request>" [--conversation <name>] [--configFile <path>] [--instructions <path>] [--skills <path>] [--image <paths>]
```

--request       The task or request to process (positional argument)
--conversation  Conversation name; selects `.agent/history/<name>.json` (default: `default`)
--configFile    Path to model configuration file (default: `config.yaml`)
--instructions  Path to custom instructions file (default: `AGENTS.md` if present, else none)
--skills        Path to skills directory (default: `skills` directory if present, else none)
--image         Image file paths, comma-separated (default: none)

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
aux4 agent ask "create a REST API for user management"
```

Continue a named conversation:

```bash
aux4 agent ask "add pagination to the list endpoint" --conversation user-api
```
