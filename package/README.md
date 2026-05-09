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

Start the agent. Must be called before using `agent ask`.

```bash
aux4 agent start [--every <interval>] [--queuePort <port>]
```

### `agent stop`

Stop the agent.

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
