#### Description

The `agent` command group provides an AI agent that understands, plans, and executes tasks with research, knowledge management, and on-demand skills.

Available subcommands:

- **start** — Start the agent services
- **stop** — Stop the agent services
- **ask** — Send a request to the agent
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
aux4 agent start
aux4 agent ask "set up a Node.js project with TypeScript"
aux4 agent stop
```
