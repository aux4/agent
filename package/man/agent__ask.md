#### Description

The `ask` command sends a request to the agent. The agent interprets the request, searches its knowledge base for context, executes the work, and reports results. If it needs clarification, it asks.

The queue server must be running before executing this command.

#### Usage

```bash
aux4 agent ask "<request>" [--configFile <path>] [--instructions <path>] [--skills <path>] [--history <path>] [--memory <folder>] [--queuePort <port>]
```

--request       The task or request to process (positional argument)
--configFile    Path to model configuration file (default: config.yaml or built-in)
--instructions  Path to custom instructions file (default: built-in)
--skills        Path to skills directory (default: none)
--history       Path to conversation history file (default: manager-history.json)
--memory        Knowledge base folder for session memories (default: .memory)
--queuePort     Queue server port (default: 8420)

#### Example

```bash
aux4 queue start &
aux4 agent ask "create a REST API for user management"
```
