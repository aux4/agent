#### Description

Internal command called by cron on each daemon cycle. Checks for incomplete tasks and resumes the agent if work is found. Not intended for manual use.

#### Usage

```bash
aux4 agent daemon check [options]
```

#### Example

This command is called automatically by the cron scheduler.
