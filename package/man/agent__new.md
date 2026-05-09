#### Description

The `new` command starts a new conversation. It saves a summary of the current session to the knowledge base as memory, then clears the history file. The next `agent ask` starts fresh, but past context is searchable in the KB.

If the history file is empty or doesn't exist, the command does nothing and just reports a new conversation started.

#### Usage

```bash
aux4 agent new [--configFile <path>] [--history <path>] [--memory <folder>]
```

--configFile  Path to model configuration file (default: config.yaml)
--history     Path to conversation history file (default: manager-history.json)
--memory      Knowledge base folder (default: .memory)

#### Example

```bash
aux4 agent new
```

```text
New conversation started
```
