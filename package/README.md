# agent/agent

AI agent with research, planning, task management, and iterative execution powered by on-demand skills.

## Installation

```bash
aux4 aux4 pkger install agent/agent
```

## Quick Start

```bash
# Start the queue server
aux4 queue start &

# Send a request
aux4 agent ask "create a Python REST API with Flask"
```

## Commands

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

### `agent status`

Check the progress of a named task.

```bash
aux4 agent status "<task-name>"
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

### `agent daemon start`

Start the agent daemon to check for work on a schedule.

```bash
aux4 agent daemon start [--every <interval>] [--queuePort <port>]
```

### `agent daemon stop`

Stop the agent daemon.

```bash
aux4 agent daemon stop
```

### `agent daemon check`

Internal command called by cron to check for pending work.

### `agent daemon status`

Show the daemon status and schedule.

## Configuration

```yaml
config:
  agent:
    model:
      type: bedrock
      model: global.anthropic.claude-sonnet-4-5-20250929-v1:0

    compaction:
      contextWindow: 200000
      maxContextPercent: 85
      keepLastMessages: 6
```
