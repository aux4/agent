#### Description

The `start` command starts the agent daemon. It launches the queue server and cron scheduler, then registers a recurring check task. Zero cost when idle.

#### Usage

```bash
aux4 agent daemon start [--every <interval>] [--queuePort <port>] [--configFile <path>] [--history <path>] [--memory <folder>]
```

--every       How often to check for work (default: 5 min)
--queuePort   Queue server port (default: 8420)
--configFile  Path to model configuration file
--history     Path to conversation history file (default: manager-history.json)
--memory      Knowledge base folder (default: .memory)

#### Example

```bash
aux4 agent daemon start --every "10 min"
```

```text
Manager daemon started (checking every 10 min)
```
