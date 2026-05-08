#### Description

The `status` command shows the progress of a named task list, displaying all tasks and their completion state.

#### Usage

```bash
aux4 agent status "<task-name>"
```

--name  The task name (positional argument)

#### Example

```bash
aux4 agent status "user-auth"
```

```text
user-auth
  [x] Set up OAuth provider
  [x] Create login endpoint
  [ ] Add session management
```
