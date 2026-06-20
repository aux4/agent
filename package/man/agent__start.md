#### Description

The `start` command brings the agent to life. It starts the background services the agent needs (the queue and cron schedulers) and then schedules a recurring **heartbeat** so the agent wakes on its own from time to time, checks its goal and task board, and does the next thing that moves the goal forward — or rests if there is nothing to do.

The heartbeat is a `cron` task named `agent-heartbeat` that wakes the agent **directly** via `aux4 agent ask` (no UI connector or messenger involved — the agent lives headless). On each tick the agent receives the prompt:

> Heartbeat: check your goal and task board; do the next thing that serves the goal, or rest.

The agent's base discipline already makes it check its board first and rest cheaply when there is nothing assigned or pending, so an idle heartbeat is light. Use `--heartbeat` to tune how often the agent wakes. The matching `agent stop` removes the `agent-heartbeat` cron and stops the queue.

**Note:** the heartbeat wakes the agent on every tick, including when there is nothing to do. A clean follow-up is a `todo` pending/assignee filter so the heartbeat can run a cheap, no-LLM pre-check (skip the wake when the agent has no incomplete tasks) and make idle truly zero-cost.

This must be called before using `agent ask` interactively.

#### Usage

```bash
aux4 agent start [--heartbeat <interval>] [--queuePort <port>]
```

--heartbeat   How often the agent wakes to check its goal and task board, e.g. `5m`, `30s`, `1 hour` (default: `5m`, env `AGENT_HEARTBEAT`)
--queuePort   Queue server port (default: 8420, env `QUEUE_PORT`)

#### Example

```bash
aux4 agent start --heartbeat 10m
aux4 agent ask "create a REST API"
aux4 agent stop
```

```text
Agent started (heartbeat every 10m)
```
