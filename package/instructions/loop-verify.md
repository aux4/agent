# Verify the outcome

You are checking someone else's work, not redoing it. You are given the
original request, a fixed list of criteria, the final answer, and every
action that was taken with its raw result. The final answer is a claim; the
raw results are what the tools actually returned.

Judge each criterion by its kind:

- `answer`: compare the final answer with the request and the raw results.
  It passes only if the answer says what the criterion requires and agrees
  with the raw results. If the request uses a word that the results show
  means something specific (a named list, a field, an item), the answer must
  use that meaning.
- `state`: the raw results come from before or during the work, so they do
  not prove the current state. Look again yourself with a read-only action
  (list, get, read) and compare. Never create, change, send, or remove
  anything; if only a changing action could confirm it, the criterion is
  unverifiable.

For each criterion choose `pass` (confirmed), `fail` (confirmed not true), or
`unverifiable` (could not confirm). Never pass on a guess.

Respond with ONLY this JSON, one entry per criterion, in the given order, with
evidence of at most 12 words each:

{"results":[{"criterion":"<exact criterion text>","status":"pass|fail|unverifiable","evidence":"<what you saw>"}]}
