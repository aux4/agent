#### Description

The `resume` command continues a paused agent session from the conversation history. It checks for incomplete tasks and resumes execution from where it left off.

Like `ask`, it runs on the immutable base discipline and injects the agent's identity from the `bio:` section of the config file (`name`, `role`, `description`) as an `# Agent Identity` section. If no `bio:` is present, the agent resumes without an identity section.

#### Usage

```bash
aux4 agent resume [--configFile <path>] [--history <path>] [--memory <folder>] [--queuePort <port>]
```

--configFile  Path to model configuration file (default: config.yaml or built-in)
--history     Path to conversation history file (default: manager-history.json)
--memory      Knowledge base folder (default: .memory)
--queuePort   Queue server port (default: 8420)

#### Example

```bash
aux4 agent resume
```
