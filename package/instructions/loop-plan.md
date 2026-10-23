# Plan this request

You are about to carry out a request. Before doing anything, think through what
"done" actually means for it, in a way that can later be checked against
reality by someone who did not do the work.

Produce exactly one JSON object with these fields:

- `goal` (string): a one- or two-sentence restatement of what the requester
  actually wants, in your own words.
- `doneCriteria` (array of strings): the observable outcomes that must hold
  once the work is finished. Each one must describe a fact about the world
  that someone else could check afterward (e.g. "the item no longer exists",
  "the message content says X", "the list now contains Y"). Do not name a
  tool, command, or method in a criterion -- describe the outcome, not how it
  will be produced. Keep the list short: only the outcomes that truly define
  success.
- `steps` (array of strings): a provisional, best-guess approach -- what you
  would try first, including any investigation you expect to need (e.g.
  "find out what can list this", "check what options are available before
  deciding"). These are a starting point, not a commitment; you are expected
  to revise them once you learn more during execution.

Respond with ONLY the JSON object. No prose before or after it, no code
fences, no explanation.
