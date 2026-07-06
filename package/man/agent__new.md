#### Description

The `new` command starts a new conversation. It consolidates the current conversation's history into long-term memory, then clears the history file so the next `agent ask` starts fresh — while the consolidated summary stays searchable in the knowledge base.

Consolidation runs `aux4 ai agent remember` over the conversation's history file (`.agent/history/<conversation>.json`, default `default`), then stores the resulting summary as a knowledge entry in the `.agent/memory` knowledge base (topic `session-<date>-<time>`, tagged `session`). Finally it removes the history file.

If the history file is empty or doesn't exist, nothing is remembered and the command just reports a new conversation started.

#### Usage

```bash
aux4 agent new [--conversation <name>] [--configFile <path>]
```

--conversation  Conversation name; selects `.agent/history/<name>.json` (default: `default`)
--configFile    Path to model configuration file (default: `config.yaml`)

#### Example

```bash
aux4 agent new --conversation user-api
```

```text
New conversation started
```
