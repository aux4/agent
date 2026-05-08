#### Description

The `daemon` command group controls the agent's autonomous daemon mode. When active, the agent periodically checks for incomplete tasks and resumes them automatically. Zero cost when idle.

Available subcommands:

- **start** — Start the daemon on a schedule
- **stop** — Stop the daemon
- **check** — Internal check called by cron
- **status** — Show daemon status

#### Usage

```bash
aux4 agent daemon <subcommand> [options]
```

#### Example

```bash
aux4 agent daemon start --every "5 min"
```
