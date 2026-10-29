# agent loop

## deterministic plan/verify/retry primitives

### should pass the agent-loop unit suite

```timeout
15000
```

```execute
node agent-loop.test.mjs
```

```expect:partial
ℹ pass
```

### should pass the ask entry-point unit suite

```timeout
15000
```

```execute
node ask.test.mjs
```

```expect:partial
pass 5
```

## the ask command

### should pass a request with spaces and quotes to the loop intact

```timeout
60000
```

```execute
AUX4_BIN=$PWD/fake-aux4.mjs aux4 agent ask "Email them: it's at 14:00, \"room 2\"" --conversation fake-request-test
rm -rf .agent
```

```expect
REQUEST: Email them: it's at 14:00, "room 2"
```
