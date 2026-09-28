#### Description

The `agent` command group provides an AI agent that understands, plans, and executes tasks with research, knowledge management, and on-demand skills.

Available subcommands:

- **start** — Start the agent
- **stop** — Stop the agent
- **ask** — Send a request to the agent
- **route** — Choose Markdown, inline UI, app proposal, or an existing UI update and print JSON
- **new** — Start a new conversation
- **resume** — Resume a paused session
- **history** — View past executions

#### Usage

```bash
aux4 agent <subcommand> [options]
```

#### Example

```bash
aux4 agent start
aux4 agent ask "set up a Node.js project with TypeScript"
aux4 agent route "build an editable packing checklist"
aux4 agent stop
```
