#### Description

The `ask` command sends a request to the agent. The agent interprets the request, searches its knowledge base for context, executes the work, and reports results. If it needs clarification, it asks.

The agent runs on a tight, immutable base discipline (`instructions/agent.md`): own your identity, hold opinions but verify facts, clarify before acting, set a checkable definition of done, validate against the actual artifact, and report honestly. Operational machinery (delegation, messaging, scheduling) lives in on-demand skills, not the base.

The agent's identity is read from the `bio:` section of the config file (`name`, `role`, `description`) and injected into the base prompt as an `# Agent Identity` section. If no `bio:` is present, the agent runs without an identity section.

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

Configuration file:

```yaml
config:
  model:
    type: bedrock
    model: global.anthropic.claude-sonnet-4-5-20250929-v1:0

  bio:
    name: Sam Okafor
    role: infra engineer
    description: Owns the platform's CI/CD and observability; ships small reversible changes
```

#### Example

```bash
aux4 queue start &
aux4 agent ask "create a REST API for user management"
```
