---
name: search
description: Find files by glob pattern and search file contents with regex
---

# Search Skill

## Commands

### Find Files

```
executeAux4("search files \"<pattern>\" --path <dir> --exclude <dirs> --maxDepth <n>")
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| pattern | Glob pattern (e.g., `*.go`, `**/*.md`) | required |
| --path | Directory to search | `.` |
| --exclude | Comma-separated dirs to skip | `node_modules,.git` |
| --maxDepth | Max recursion depth | unlimited |

Examples:
```
executeAux4("search files \"*.go\" --path src")
executeAux4("search files \"*.md\" --maxDepth 0")
executeAux4("search files \"*.js\" --exclude \"node_modules,.git,dist\"")
```

### Search Content

```
executeAux4("search content \"<regex>\" --path <dir> --include <glob> --exclude <dirs> --limit <n> --context <n>")
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| pattern | Regex pattern (case-insensitive) | required |
| --path | Directory to search | `.` |
| --include | File glob filter (e.g., `*.go`) | all files |
| --exclude | Comma-separated dirs to skip | `node_modules,.git` |
| --limit | Max matches | `50` |
| --context | Lines before/after match | `0` |

Output format: `file:line: content`

Examples:
```
executeAux4("search content \"func main\" --include \"*.go\"")
executeAux4("search content \"TODO|FIXME\" --context 2 --limit 20")
executeAux4("search content \"import.*react\" --include \"*.tsx\" --path src")
```

## When to Use

- **Find files**: locate config files, source files, test files by pattern
- **Search content**: find function definitions, TODOs, error patterns, imports, usages
- Use `--include` to narrow content search to relevant file types
- Use `--context` when you need to understand surrounding code
- Use `--limit` to control output size for token management
