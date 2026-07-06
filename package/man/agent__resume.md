#### Description

The `resume` command continues a paused agent session from its conversation history. It reloads `.agent/history/<conversation>.json` (default `default`) and sends a fixed prompt telling the agent to check its current tasks with `aux4 todo list` and continue from where it left off.

Like `ask`, it runs on the immutable base discipline and injects the agent's identity from the `bio:` section of the config file (`name`, `role`, `description`) as an `# Agent Identity` section. If no `bio:` is present, the agent resumes without an identity section. When `--instructions` is omitted it picks up `AGENTS.md` from the current directory if present; when `--skills` is omitted it picks up a `skills` directory if present.

#### Usage

```bash
aux4 agent resume [--conversation <name>] [--configFile <path>] [--instructions <path>] [--skills <path>]
```

--conversation  Conversation name; selects `.agent/history/<name>.json` (default: `default`)
--configFile    Path to model configuration file (default: none; falls back to the runtime built-in)
--instructions  Path to custom instructions file (default: `AGENTS.md` if present, else none)
--skills        Path to skills directory (default: `skills` directory if present, else none)

#### Example

```bash
aux4 agent resume --conversation user-api
```
