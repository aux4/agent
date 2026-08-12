#### Description

The `ask` command sends a request to the agent. The agent interprets the request, searches its knowledge base for context, executes the work, and reports results. If it needs clarification, it asks.

The agent runs on a tight, immutable base discipline (`instructions/agent.md`): own your identity, hold opinions but verify facts, clarify before acting, set a checkable definition of done, validate against the actual artifact, and report honestly. Operational machinery (delegation, messaging, scheduling) lives in on-demand skills, not the base.

The agent's identity is read from the `bio:` section of the config file (`name`, `role`, `description`) and injected into the base prompt as an `# Agent Identity` section. If no `bio:` is present, the agent runs without an identity section.

The queue server must be running before executing this command.

#### Usage

```bash
aux4 agent ask "<request>" [--config <section>] [--configFile <path>] [--conversation <name>] \
  [--instructions <path>] [--skills <path>] [--image <paths>] \
  [--tools <list>] [--policy <json>] [--permissions <json>]
```

--request       The task or request to process (positional argument)
--config        Config section in --configFile to take the model from. Without it the agent falls back to the default model — which silently means the hosted one even when the section you named is local
--configFile    Path to model configuration file (default: config.yaml or built-in)
--conversation  Conversation name; each conversation keeps its own history
--instructions  Path to custom instructions file (default: built-in)
--skills        Path to skills directory (default: none)
--image         Image file paths, comma-separated
--tools         Comma-separated allow-list of tools to bind (e.g. `executeAux4,aux4Skill`). Binding every tool sends every tool description on each request; on a small model that context floor alone can stop it calling tools at all. Default: all tools
--policy        Guardrails as JSON, e.g. `{"budget":{"calls":40}}`. Without a budget a run is unbounded
--permissions   Command allow-list as JSON, e.g. `{"allow":["aux4 google gmail list"]}`. Confines the run to those commands; omit to leave it unrestricted

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
