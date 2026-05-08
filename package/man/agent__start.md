#### Description

The `start` command starts the agent. This must be called before using `agent ask`. It starts all required background services and begins periodic work detection.

#### Usage

```bash
aux4 agent start [--every <interval>] [--queuePort <port>] [--configFile <path>] [--history <path>] [--memory <folder>]
```

--every       How often to check for pending work (default: 5 min)
--queuePort   Queue server port (default: 8420)
--configFile  Path to model configuration file
--history     Path to conversation history file (default: manager-history.json)
--memory      Knowledge base folder (default: .memory)

#### Example

```bash
aux4 agent start
aux4 agent ask "create a REST API"
aux4 agent stop
```

```text
Agent started
```
