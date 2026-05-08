# agent/agent

AI agent with manager/worker architecture. Combines `agent/manager` and `agent/worker` into a single package that presents as one unified agent.

Behind the scenes, a manager agent handles user communication, task tracking, knowledge management, and orchestration, while a worker agent focuses on executing tasks. The split is invisible to the user.

## Installation

```bash
aux4 aux4 pkger install agent/agent
```

## Quick Start

```bash
# Start the queue server (required for agent communication)
aux4 queue start &

# Run a task
aux4 agent run "create a Python REST API with Flask"
```

## Commands

### `agent run`

Run the agent for a given request. The manager interprets the request, dispatches work to the worker, and reports results.

```bash
aux4 agent run "<request>" [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `<request>` | The task or request to process | (required) |
| `--configFile` | Path to model configuration file | `config.yaml` or built-in |
| `--history` | Path to conversation history file | `manager-history.json` |
| `--memory` | Knowledge base folder | `.memory` |
| `--queuePort` | Queue server port | `8420` |
| `--workerInstructions` | Path to custom worker instructions | worker built-in |
| `--workerConfigFile` | Path to custom worker configuration | worker built-in |

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

## Architecture

```text
user <-> agent/agent <-> agent/manager <-> agent/worker
                              |
                    memory, tasks, KB,
                    scheduling, channels
```

- **agent/agent** — unified entry point (this package)
- **agent/manager** — orchestrator: user communication, KB, memory, tasks, scheduling
- **agent/worker** — executor: file operations, commands, search
- **aux4/agent-channel** — communication layer between manager and worker

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
