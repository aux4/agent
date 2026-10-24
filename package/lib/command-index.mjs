// Finds which installed aux4 commands may fit a request, from aux4's own
// command file (global.aux4: every installed command with its help text).
// Drilling through `--help` only works when the agent already guesses the
// right group; two packages can offer the same thing under different groups
// (a local calendar and a hosted one), so the harness surfaces the candidates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STOP = new Set(["the", "and", "for", "you", "your", "with", "that", "this", "from", "into", "what", "who", "how", "are", "was", "will", "can", "not", "but", "out", "get", "set", "all", "any", "one", "use", "has", "have", "need", "want", "please", "then", "them", "they", "its", "our", "via", "about", "would", "should", "could", "there", "here", "when", "which", "also", "only", "just", "make", "give", "tell", "show", "check", "find", "first", "next", "last", "most", "recent", "directly", "first", "without", "same", "day", "time", "go", "ahead", "me", "my", "it", "is", "to", "of", "on", "in", "at", "do", "be", "an", "or", "by", "if", "as"]);

export function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .map(w => w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, ""))
    .filter(w => w.length > 2);
}

export function globalFile() {
  return process.env.AUX4_GLOBAL_FILE || path.join(os.homedir(), ".aux4.config", "global.aux4");
}

// Walks profile routes from `main` and returns every command group: its path
// (e.g. "google calendar events"), its own description, and its leaf commands.
export function loadGroups(file = globalFile()) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const profiles = new Map((data?.profiles || []).map(p => [p.name, p]));
  const groups = [];
  const seen = new Set();
  const walk = (name, route, description) => {
    if (seen.has(name) || route.length > 6) return;
    seen.add(name);
    const profile = profiles.get(name);
    if (!profile) return;
    const leaves = [];
    for (const command of profile.commands || []) {
      const first = String((command.execute || [""])[0] || "");
      const text = String(command.help?.text || "").split("\n")[0];
      const sub = first.match(/^profile:(.+)$/);
      if (sub) walk(sub[1], [...route, command.name], text);
      else leaves.push({ name: command.name, text });
    }
    if (leaves.length && route.length) groups.push({ path: route.join(" "), description: description || "", leaves });
  };
  walk("main", [], "");
  return groups;
}

// Scores groups by the request's words: a match in the group's path counts
// most, then its description, then its commands' names and descriptions.
// A URL in the request means a web page, whatever else it says.
export function requestWords(request) {
  const text = String(request || "");
  const extra = /https?:\/\/\S+/i.test(text) ? " web page browser url open" : "";
  return new Set(words(text.replace(/https?:\/\/\S+/gi, " ") + extra));
}

// Equal words match; so do words sharing a 4-letter ending (email/gmail),
// except endings shared by unrelated words (confirmation/subscription).
const COMMON_ENDINGS = new Set(["tion", "sion", "ment", "ness", "able", "ible", "ship", "ance", "ence", "ious", "ally", "ture", "ight", "ting", "ring"]);
function related(a, wanted) {
  if (wanted.has(a)) return true;
  if (a.length < 5) return false;
  const tail = a.slice(-4);
  if (COMMON_ENDINGS.has(tail)) return false;
  for (const w of wanted) if (w.length >= 5 && w.slice(-4) === tail) return true;
  return false;
}

export function matchGroups(request, groups, limit = 5) {
  const want = requestWords(request);
  if (!want.size || !groups.length) return [];
  // Rare words say more: weight each word by how few groups use it.
  const docWords = groups.map(g => new Set([...words(g.path), ...words(g.description)]));
  const df = new Map();
  for (const set of docWords) for (const w of set) df.set(w, (df.get(w) || 0) + 1);
  const n = groups.length;
  const weight = w => Math.log((n + 1) / ((df.get(w) || 0) + 1)) / Math.log(n + 1);
  const scored = groups.map((g, i) => {
    let score = 0;
    for (const w of new Set(words(g.path))) if (related(w, want)) score += 3 * weight(w);
    for (const w of new Set(words(g.description))) if (related(w, want)) score += 2 * weight(w);
    const leafWords = new Set(g.leaves.flatMap(l => [...words(l.name), ...words(l.text)]));
    for (const w of leafWords) if (want.has(w)) score += 0.5 * weight(w);
    // The group's own commands, most relevant to the request first.
    const leaves = [...g.leaves].sort((x, y) =>
      words(`${y.name} ${y.text}`).filter(w => want.has(w)).length - words(`${x.name} ${x.text}`).filter(w => want.has(w)).length);
    return { ...g, leaves, score };
  }).filter(g => g.score >= 1.5);
  scored.sort((x, y) => y.score - x.score || x.path.length - y.path.length);
  // A subgroup adds little once its parent group is listed: leave the slot
  // for another source (another package offering the same kind of thing).
  const picked = [];
  for (const g of scored) {
    if (picked.some(p => g.path.startsWith(`${p.path} `))) continue;
    picked.push(g);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function describeMatches(matches, perGroup = 6) {
  if (!matches.length) return "";
  const lines = ["Installed commands that may fit this request (check their --help; more than one may apply):"];
  for (const g of matches) {
    const leaves = g.leaves.slice(0, perGroup).map(l => l.name).join(", ");
    lines.push(`- aux4 ${g.path}${g.description ? ` (${g.description})` : ""}: ${leaves}${g.leaves.length > perGroup ? ", ..." : ""}`);
  }
  return lines.join("\n");
}

export function commandHints(request, file = globalFile()) {
  return describeMatches(matchGroups(request, loadGroups(file)));
}
