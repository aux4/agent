# agent

## start

### should display help

```execute
aux4 agent start --help
```

```expect:partial
Start the agent
```

### should expose the heartbeat option

```execute
aux4 agent start --help
```

```expect:partial
How often the agent wakes
```

### should schedule the agent-heartbeat cron

```execute
aux4 agent start --showSource
```

```expect:partial
cron add --name agent-heartbeat
```

## stop

### should display help

```execute
aux4 agent stop --help
```

```expect:partial
Stop the agent
```

### should remove the agent-heartbeat cron

```execute
aux4 agent stop --showSource
```

```expect:partial
cron remove --name agent-heartbeat
```

## ask

### should display help

```execute
aux4 agent ask --help
```

```expect:partial
Send a request to the agent
```

## new

### should display help

```execute
aux4 agent new --help
```

```expect:partial
Start a new conversation
```

## resume

### should display help

```execute
aux4 agent resume --help
```

```expect:partial
Resume a paused agent session
```

## history

### should display help

```execute
aux4 agent history --help
```

```expect:partial
View past executions
```
