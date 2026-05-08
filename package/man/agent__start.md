#### Description

The `start` command starts the agent services required for operation. This must be called before using `agent ask`.

Currently starts the queue server in the background for channel communication.

#### Usage

```bash
aux4 agent start [--queuePort <port>]
```

--queuePort  Queue server port (default: 8420)

#### Example

```bash
aux4 agent start
aux4 agent ask "create a REST API"
```

```text
Agent started
```
