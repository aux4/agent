#### Description

The `run` command processes a user request. The manager agent interprets the request, searches knowledge for context, dispatches work to a worker agent via a communication channel, answers worker questions, and reports results.

The queue server must be running before executing this command.

#### Usage

```bash
aux4 agent run "<request>" [--configFile <path>] [--history <path>] [--memory <folder>] [--queuePort <port>] [--workerInstructions <path>] [--workerConfigFile <path>]
```

--request             The task or request to process (positional argument)
--configFile          Path to model configuration file (default: config.yaml or built-in)
--history             Path to conversation history file (default: manager-history.json)
--memory              Knowledge base folder for session memories (default: .memory)
--queuePort           Queue server port for channels (default: 8420)
--workerInstructions  Path to custom worker instructions (default: worker built-in)
--workerConfigFile    Path to custom worker configuration (default: worker built-in)

#### Example

```bash
aux4 queue start &
aux4 agent run "create a REST API for user management"
```
