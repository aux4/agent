---
name: aux4
description: How to discover and use aux4 commands
---

# aux4 CLI

aux4 is a CLI tool. All commands are run via `executeAux4`. Remember: `executeAux4` already adds the `aux4` prefix.

## Discovering Commands

```
executeAux4("--help")                    # list ALL top-level commands
executeAux4("google --help")             # show subcommands of 'google'
executeAux4("google sheets --help")      # show subcommands of 'google sheets'
executeAux4("pdf --help")                # show subcommands of 'pdf'
```

**When you don't know a command, start with `--help` and drill down. Never guess.**

## Command Structure

Commands are hierarchical with spaces:

```
executeAux4("google sheets values get <id> \"Sheet1!A1:Z100\"")
executeAux4("pdf parse \"file.pdf\"")
executeAux4("browser open --url \"https://example.com\"")
executeAux4("search files \"*.pdf\" --path company")
executeAux4("kb list --folder .agent/memory")
executeAux4("todo list")
executeAux4("jobs list")
```

## Common Mistakes

- **WRONG**: `executeAux4("aux4 pdf parse ...")` — double `aux4`
- **RIGHT**: `executeAux4("pdf parse ...")`
- **WRONG**: `executeAux4("sheets values get ...")` — `sheets` is a subcommand of `google`
- **RIGHT**: `executeAux4("google sheets values get ...")`
- **WRONG**: guessing 10 command names
- **RIGHT**: `executeAux4("--help")` then drill down

## Authentication Errors

Some commands need authentication (Google, etc.). If you get an auth error:
1. Check `--help` for the auth command
2. Run the login flow
3. Retry the original command

## Package Management

```
executeAux4("aux4 pkger list")                    # list installed packages
executeAux4("aux4 pkger list --filter pdf")       # find installed packages by name
executeAux4("aux4 pkger search pdf")              # search for packages to install (not yet installed)
executeAux4("aux4 pkger man <scope>/<package>")   # read full package documentation
executeAux4("aux4 man <command>")                 # read command manual
```

**If a tool doesn't exist**, search for it: `executeAux4("aux4 pkger search <keyword>")`. If you find a useful package, let the user know it can be installed.

Note: `aux4 pkger` and `aux4 man` need the `aux4` prefix because `aux4` is the command name.
