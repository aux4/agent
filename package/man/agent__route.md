#### Description

The `route` command chooses how a response should be presented without running the agent. It prints
one versioned JSON decision and never generates UI schemas or artifacts.

The stable modes are:

- `markdown` — written answers, research, summaries, and simple confirmations.
- `markdown+inline-ui` — editable collections, forms, tables, trackers, dashboards, and repeated interaction.
- `markdown+app-proposal` — a request to publish or deploy the experience as an app.
- `update-existing-ui` — a follow-up that modifies the active artifact.

Precedence is deterministic: an explicit `--presentation`; then a pure show/view/open/display request
that reuses a complete typed active artifact; then an explicit format request in the text; then JEV
classification over the known candidates. Artifact reuse emits
`source: active-artifact-reuse`, `reuseActiveArtifact: true`, and `requiresBuilder: false`. The core
criterion is whether the user benefits from manipulating structured state after the response. With
an active artifact, JEV distinguishes prose, modification, and a distinct new UI; without one, the
update candidate is not offered. When JEV is unavailable, routing conservatively returns Markdown.
A valid probability below `--classifierThreshold`, a non-probability
score, or an unknown candidate returns `markdown`.

#### Usage

```bash
aux4 agent route "<request>" [--presentation <mode>] \
  [--conversationContext <text>] [--activeArtifact <json>] \
  [--classifierThreshold <probability>] [--classifyModel <model>]
```

--request              Current user request (positional argument)
--presentation         Explicit mode or `auto` (default: auto)
--conversationContext  Compact recent context used by the classifier
--activeArtifact       Active artifact as JSON; complete typed artifacts can be reused by pure view requests
--classifierThreshold  Minimum probability for a UI mode (default: 0.55)
--classifyModel         JEV model identifier (default: jev-1.13.0)
--classifyBaseUrl       Optional JEV API base URL override
--classifyApiKey        Optional JEV API key (env: TYPESAFE_API_KEY)
--brokerUrl             Optional inference broker URL (env: AUX4_INFERENCE_BROKER_URL)
--brokerToken           Optional inference broker token (env: AUX4_INFERENCE_BROKER_TOKEN)

#### Example

```bash
aux4 agent route "move the release card to shipped" --activeArtifact '{"id":"release-board","kind":"aux4.app"}'
```

```json
{
  "version": 1,
  "mode": "update-existing-ui",
  "source": "classifier",
  "confidence": 0.94,
  "reason": "jev-selected-known-candidate",
  "criterion": "benefit-from-manipulating-structured-state",
  "requiresBuilder": true
}
```
