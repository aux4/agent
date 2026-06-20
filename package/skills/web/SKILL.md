---
name: web
description: Search the web, fetch pages, browse dynamic sites, download files
---

# Web

Search the web, fetch URL content, interact with forms, and download files.

## Starting the Browser

The browser daemon must be running before you can open pages. Start it as a background job:

```
executeAux4("jobs run \"aux4 browser start --persistent true\"")
```

Wait a few seconds before opening pages.

## Session Management

**Open ONE session and reuse it.** Do not open a new session for every URL — use tabs instead.

```
executeAux4("browser open --url \"<url>\"")              # opens session, returns session ID
executeAux4("browser new-tab --session <id> --url \"<url>\"")   # open new tab in same session
executeAux4("browser switch-tab --session <id> --tab <n>")       # switch between tabs
executeAux4("browser close-tab --session <id> --tab <n>")        # close a tab when done
executeAux4("browser close --session <id>")                      # close entire session when ALL done
```

**CRITICAL: Always close your session when finished.** Unclosed sessions leak Chrome processes.

## Quick Commands

| Command | Description |
|---------|-------------|
| `browser open --url "<url>"` | Open session, returns session ID |
| `browser visit --session <id> --url "<url>"` | Navigate current tab to new URL |
| `browser content --session <id>` | Get page content as markdown |
| `browser snapshot --session <id> --format text` | Get accessibility tree (faster than content) |
| `browser close --session <id>` | Close session — **always do this** |
| `browser new-tab --session <id> --url "<url>"` | Open URL in new tab |
| `browser close-tab --session <id> --tab <n>` | Close a tab |
| `browser click --session <id> --name "<text>"` | Click a button |
| `browser type --session <id> --name "<label>" --value "<text>"` | Fill input field |

## Browsing Workflow

**One session, multiple pages:**

```
# Open session
executeAux4("browser open --url \"<first-url>\"")  → session ID

# Read first page
executeAux4("browser content --session <id>")

# Navigate to next page (reuse same tab)
executeAux4("browser visit --session <id> --url \"<next-url>\"")
executeAux4("browser content --session <id>")

# Or use tabs for parallel pages
executeAux4("browser new-tab --session <id> --url \"<another-url>\"")
executeAux4("browser switch-tab --session <id> --tab 1")
executeAux4("browser content --session <id>")

# ALWAYS close when done
executeAux4("browser close --session <id>")
```

## Accessibility Snapshots

Get a structured view of the page without full content:

```
executeAux4("browser snapshot --session <id> --format text")
```

Enable auto-snapshots to receive page state after every action:

```
executeAux4("browser set-snapshot --session <id> --mode auto")
```

## Disambiguation

When multiple elements share the same name, use `--index` (1-based):

```
executeAux4("browser click --session <id> --name \"Add\" --index 2")
executeAux4("browser click-text --session <id> --text \"Learn more\" --index 3")
```

## Scroll to Element

```
executeAux4("browser scroll --session <id> --to \"Product Details\"")
```

## Rules

- **Reuse sessions.** One session per task. Use `visit` or tabs for multiple URLs.
- **ALWAYS close sessions.** `browser close --session <id>` when done. Unclosed sessions leak Chrome processes.
- Use `browser content` to read pages, not `readFile` or `curl`.
- Use `browser snapshot` for quick checks — it's faster than `content`.
- Do NOT use `searchFiles` on temp directories — browser output goes through `content` and `snapshot`, not raw files.
