#### Description

The `agent` command group provides an AI agent that understands, plans, and executes tasks. It combines a manager agent (orchestration, KB, memory, tasks) with a worker agent (execution) behind a single unified interface.

Available subcommands:

- **run** — Process a request
- **status** — Check task progress
- **resume** — Resume a paused session
- **history** — View past executions
- **daemon** — Autonomous daemon mode

#### Usage

```bash
aux4 agent <subcommand> [options]
```

#### Example

```bash
aux4 agent run "set up a Node.js project with TypeScript"
```
