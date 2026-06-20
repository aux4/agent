---
name: google
description: Google Workspace tools — Sheets, Drive, authentication
---

# Google Workspace

Use `executeAux4("google --help")` to see all available Google commands.

## Key Concepts

- `.gsheet` files are NOT spreadsheets — they are shortcut files. Read them to extract the `doc_id` (the spreadsheet ID), then use `google sheets` commands.
- `.gdoc` and `.gslides` files work the same way — they contain a `doc_id` for the Google API.
- All Google commands live under `google`: `google sheets`, `google drive`, `google auth`.

## Authentication

When a Google command fails with an auth error, **immediately start the login flow and give the user the link**:

1. `executeAux4("jobs run \"aux4 google auth login --services sheets,drive --tee true\"")`
2. Wait a few seconds: `executeAux4("jobs output <job-id>")`
3. Extract the `https://accounts.google.com/...` URL and give it to the user
4. The job keeps running while the user authenticates
5. After user confirms, retry the original command

**Do NOT tell the user to run the login command themselves.**

## Discovering Commands

```
executeAux4("google --help")                    # all Google commands
executeAux4("google sheets --help")             # Sheets commands
executeAux4("google sheets values --help")      # read/write cell values
executeAux4("google drive --help")              # Drive commands
executeAux4("google auth --help")               # auth commands
```

For full documentation: `executeAux4("aux4 pkger man community/google-sheets")`
