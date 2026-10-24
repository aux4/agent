import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadGroups, matchGroups, commandHints, requestWords } from "../lib/command-index.mjs";

function fixture() {
  const profiles = [
    { name: "main", commands: [
      { name: "calendar", execute: ["profile:calendar"], help: { text: "Manage calendar events and .ics files" } },
      { name: "google", execute: ["profile:google"], help: { text: "Google commands" } },
      { name: "browser", execute: ["profile:browser"], help: { text: "Headless browser automation" } },
      { name: "db", execute: ["profile:db"], help: { text: "Database tools" } }
    ] },
    { name: "calendar", commands: [{ name: "search", execute: ["echo"], help: { text: "Search calendar events" } }, { name: "delete", execute: ["echo"], help: { text: "Delete an event" } }] },
    { name: "google", commands: [{ name: "calendar", execute: ["profile:google:calendar"], help: { text: "Google Calendar commands" } }, { name: "gmail", execute: ["profile:google:gmail"], help: { text: "Gmail commands" } }] },
    { name: "google:calendar", commands: [{ name: "events", execute: ["profile:google:calendar:events"], help: { text: "Manage events on a calendar" } }] },
    { name: "google:calendar:events", commands: [{ name: "list", execute: ["echo"], help: { text: "List events" } }, { name: "delete", execute: ["echo"], help: { text: "Delete an event" } }] },
    { name: "google:gmail", commands: [{ name: "list", execute: ["echo"], help: { text: "List messages" } }] },
    { name: "browser", commands: [{ name: "open", execute: ["echo"], help: { text: "Open a page" } }] },
    { name: "db", commands: [{ name: "list", execute: ["echo"], help: { text: "List tables" } }] }
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-index-"));
  const file = path.join(dir, "global.aux4");
  fs.writeFileSync(file, JSON.stringify({ profiles }));
  return file;
}

test("loadGroups walks profile routes into command groups", () => {
  const paths = loadGroups(fixture()).map(g => g.path).sort();
  assert.deepEqual(paths, ["browser", "calendar", "db", "google calendar events", "google gmail"]);
});

test("a calendar request surfaces every package that manages calendars", () => {
  const paths = matchGroups("Cancel the Budget review meeting on my calendar", loadGroups(fixture())).map(g => g.path);
  assert.ok(paths.includes("calendar"));
  assert.ok(paths.includes("google calendar events"));
  assert.ok(!paths.includes("db"));
});

test("a URL means a web page, and email matches gmail", () => {
  assert.ok(requestWords("look at http://x/y").has("browser"));
  const groups = loadGroups(fixture());
  assert.equal(matchGroups("open http://127.0.0.1/contact", groups)[0].path, "browser");
  assert.ok(matchGroups("read my latest email", groups).some(g => g.path === "google gmail"));
});

test("commandHints is empty when the command file is missing", () => {
  assert.equal(commandHints("anything", "/no/such/file"), "");
});
