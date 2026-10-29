# Plan this request

Before anything is done, write down what "done" means for this request, so
someone who did not do the work can check it afterward.

Produce exactly one JSON object:

- `goal` (string): the request restated in one sentence. Keep its own words
  for the things it names; do not rename them or add details it does not give.
- `doneCriteria` (array, at most 3): the outcomes that define success. Give
  every distinct part of the request its own criterion, including what a
  reply, message, or form must say -- not only the action around it (e.g. a
  request to reply saying whether a time works needs a criterion for the
  reply being sent AND one for what it must say). Dropping a part because the
  list is short is wrong; combine parts into one criterion instead of
  omitting one. Each is an object `{ "text": "...", "kind": "answer" | "state" }`:
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
  to do. Say what to find or do, not which tool to use ("open the products
  page", not "use the browser tool"): the tools are found during the work.
  Include every required operation, especially the final write: reading a
  calendar and sending a reply are separate outcomes, as are editing a form
  and saving it. These will be revised during the work.
  Include prerequisite lookups for identifiers, destination addresses, and
  required record details that the request does not supply. A person's name
  does not establish their address or record ID. Find those facts from the
  relevant records before planning to use them in a change.

- `lookFor` (array, 1 to 4 short phrases of 2 to 6 words): the kinds of
  command the work needs, including each distinct read and write operation,
  each as what it does to what, in plain words, e.g. "read email in the inbox",
  "send an email reply", "fill and submit a form on a web page", "cancel a
  meeting on the calendar". Do not omit sending, submitting or saving just
  because the reply can describe the result. No names, values or addresses
  from the request, and no tool names.
  Include the lookup needed for any missing identifier or destination, even
  when the requester did not explicitly say to look it up.

Keep every string short: one plain sentence each.

Respond with ONLY the JSON object. No prose, no code fences.
