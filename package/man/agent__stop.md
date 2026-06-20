#### Description

The `stop` command puts the agent to rest. It is symmetric with `agent start`: it removes the `agent-heartbeat` cron task (so the agent stops waking on its own) and stops the queue server. No UI connector is involved — the connector is an optional integration, not part of the agent's core lifecycle.

#### Usage

```bash
aux4 agent stop [--queuePort <port>]
```

--queuePort  Queue server port (default: 8420, env `QUEUE_PORT`)

#### Example

```bash
aux4 agent stop
```

```text
Agent stopped
```
