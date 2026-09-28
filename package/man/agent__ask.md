#### Description

The `ask` command sends a request to the agent. The agent interprets the request, searches its knowledge base for context, executes the work, and reports results. If it needs clarification, it asks.

The agent runs on a tight, immutable base discipline (`instructions/agent.md`): own your identity, hold opinions but verify facts, clarify before acting, set a checkable definition of done, validate against the actual artifact, and report honestly. Operational machinery (delegation, messaging, scheduling) lives in on-demand skills, not the base.

The agent's identity is read from the `bio:` section of the config file (`name`, `role`, `description`) and injected into the base prompt as an `# Agent Identity` section. If no `bio:` is present, the agent runs without an identity section.

The internal harness deterministically calls the installed `agent/skill-playbook` before and after
the model. A confident, fully parameterized match is replayed without asking the model to remember
the workflow. After a normal agent run, repeatable successful work can produce a save suggestion.
Failures inside these best-effort hooks fall through to the normal agent.

Presentation routing asks whether the user benefits from manipulating structured state after the
response. It chooses only a known mode and never generates a schema. Explicit format requests win.
A pure show/view/open/display request with a complete active artifact re-emits that artifact without
calling the classifier, playbook hooks, model, or builder. Other active-artifact follow-ups select
`update-existing-ui`, and low confidence or classifier failure falls back to `markdown`. The `json`
output always retains the written response in `content`.

In JSON mode, a decision with `requiresBuilder: true` invokes a bounded builder adapter. `local`
runs `aux4 agent builder build`; `cloud` runs `aux4 cloud <builderVm> generate`. Both receive the same
JSON on stdin, never shell-interpolated user input. The harness accepts only a version 1
`aux4.app` artifact with `id`, `ref`, `title`, `schema`, `state`, and `data`. Optional `key` and
`aliases` semantic identity metadata is validated and preserved for caller-owned catalogs; legacy
artifacts without these fields remain valid. Keys are bounded and path-safe, while aliases are
limited to 16 nonempty strings of at most 96 bytes each.

An explicit new-instance request for an obvious mutable collection (`new`, `separate`, `another`,
or equivalent) selects inline UI before classifier scoring. Explanation, comparison, and drafting
requests remain eligible for Markdown.

Builder `needs-decision` results append a clean Markdown question and expose typed decision metadata.
Internal validation and command-line diagnostics remain in `builder.reason`; they are not copied into
the user-facing answer.
Malformed output, timeout, and command failure retain the written response and expose only a stable,
non-secret error code. Updates preserve the active artifact identity. App proposals never deploy;
they carry explicit proposal metadata requiring confirmation.

The queue server must be running before executing this command.

#### Usage

```bash
aux4 agent ask "<request>" [--config <section>] [--configFile <path>] [--conversation <name>] \
  [--instructions <path>] [--skills <path>] [--image <paths>] \
  [--tools <list>] [--policy <json>] [--permissions <json>] \
  [--output text|json] [--presentation <mode>] \
  [--conversationContext <text>] [--activeArtifact <json>] \
  [--builderAdapter local|cloud|disabled] [--builderVm <name>] \
  [--builderDecisions <json>]
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
--output        `text` preserves the traditional Markdown response; `json` emits the typed response envelope (default: text)
--presentation  Explicit override: auto, markdown, markdown+inline-ui, markdown+app-proposal, or update-existing-ui (default: auto)
--conversationContext  Compact recent conversation context used for routing
--activeArtifact       Active artifact as JSON; pure view requests reuse a complete typed artifact, while other follow-ups prefer update-existing-ui
--playbookFolder       Learned playbook folder (default: .agent/playbooks)
--playbookThreshold    Minimum probability for deterministic replay (default: 0.15)
--classifierThreshold  Minimum probability for a UI mode (default: 0.55)
--classifyModel        JEV model identifier (default: jev-1.13.0)
--classifyBaseUrl      Optional JEV API base URL override
--classifyApiKey       Optional JEV API key (env: TYPESAFE_API_KEY)
--brokerUrl            Optional inference broker URL for presentation routing (env: AUX4_INFERENCE_BROKER_URL)
--brokerToken          Optional inference broker token (env: AUX4_INFERENCE_BROKER_TOKEN)
--builderAdapter       Builder transport: local, cloud, or disabled (default: local; env: AGENT_BUILDER_ADAPTER)
--builderVm            Cloud builder VM name (default: builder; env: AGENT_BUILDER_VM)
--builderScope         Cloud scope containing the builder VM (env: AUX4_CLOUD_SCOPE)
--builderApiUrl        Cloud API URL (default: https://api.aux4.cloud; env: AUX4_CLOUD_API_URL)
--builderTimeoutMs     Builder timeout in milliseconds, clamped to 1000-300000 (default: 120000)
--builderDecisions     Caller answers keyed by prior decision id as a JSON object
--builderBackends      Optional backend package allow-list as a JSON array
--builderAuto          Let the builder apply a clear candidate automatically; never deploys (default: true)
--builderSteps         Builder step cap, clamped to 1-50 (default: 10)
--builderModel         Optional builder model override

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
aux4 agent ask "keep a grocery list for milk and eggs" --output json
```

```json
{
  "version": 1,
  "content": "I created the grocery list.",
  "presentation": {
    "version": 1,
    "mode": "markdown+inline-ui",
    "source": "classifier",
    "confidence": 0.91,
    "reason": "jev-selected-known-candidate",
    "criterion": "benefit-from-manipulating-structured-state",
    "requiresBuilder": true
  },
  "artifacts": [
    {
      "id": "grocery-list",
      "kind": "aux4.app",
      "version": 1,
      "presentation": "inline",
      "ref": "builder://grocery-list",
      "title": "Groceries",
      "schema": {
        "type": "List",
        "props": {
          "field": "items"
        }
      },
      "state": {},
      "data": {
        "app": {},
        "package": {}
      }
    }
  ],
  "builder": {
    "status": "done"
  },
  "execution": {
    "source": "agent"
  }
}
```
