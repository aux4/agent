# Plan this request

Before anything is done, write down what "done" means for this request, so
someone who did not do the work can check it afterward.

Produce exactly one JSON object:

- `goal` (string): the request restated in one sentence. Keep its own words
  for the things it names; do not rename them or add details it does not give.
- `doneCriteria` (array, at most 3): the outcomes that define success. Each is
  an object `{ "text": "...", "kind": "answer" | "state" }`:
  - `answer`: something the final reply must say, e.g. "the reply states who
    sent the latest message". When the request asks for information, the
    criterion is that the reply gives it as it is in its source, for every
    part of the question.
  - `state`: something that must now be true outside the conversation, e.g.
    "the item no longer exists", "the message was sent and says X".
  When the reply or anything sent must convey a fact (an answer, a yes/no,
  a time), the criterion says it agrees with where that fact comes from, e.g.
  "the reply says whether the time is free, matching the schedule at that
  time" -- not merely that it says something.
  Describe outcomes, never a tool, command, or method. Use only names and
  values that appear in the request.
- `steps` (array, at most 4 short strings): a provisional approach. Start with
  how to find, from the available help, what provides each thing the request
  names (match the request's own words to the help descriptions), then what
  to do. These will be revised during the work.

Keep every string short: one plain sentence each.

Respond with ONLY the JSON object. No prose, no code fences.
