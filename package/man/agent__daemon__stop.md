#### Description

The `stop` command stops the agent daemon. Removes the cron schedule and stops background services.

#### Usage

```bash
aux4 agent daemon stop [--queuePort <port>]
```

--queuePort  Queue server port (default: 8420)

#### Example

```bash
aux4 agent daemon stop
```

```text
Manager daemon stopped
```
