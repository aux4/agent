import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadGroups, matchGroups, commandHints, requestWords, installedAppNames } from "../lib/command-index.mjs";

function fixture() {
  const profiles = [
    { name: "main", commands: [
      { name: "calendar", execute: ["profile:calendar"], help: { text: "Manage calendar events and .ics files" } },
      { name: "google", execute: ["profile:google"], help: { text: "Google commands" } },
      { name: "browser", execute: ["profile:browser"], help: { text: "Headless browser automation" } },
      { name: "db", execute: ["profile:db"], help: { text: "Database tools" } },
      { name: "validator", execute: ["profile:validator"], help: { text: "Validate input against rules" } },
      { name: "computer", execute: ["profile:computer"], help: { text: "Computer-use commands for AI agents." } }
    ] },
    { name: "calendar", commands: [{ name: "search", execute: ["echo"], help: { text: "Search calendar events" } }, { name: "delete", execute: ["echo"], help: { text: "Delete an event" } }] },
    { name: "google", commands: [{ name: "calendar", execute: ["profile:google:calendar"], help: { text: "Google Calendar commands" } }, { name: "gmail", execute: ["profile:google:gmail"], help: { text: "Gmail commands" } }] },
    { name: "google:calendar", commands: [{ name: "events", execute: ["profile:google:calendar:events"], help: { text: "Manage events on a calendar" } }] },
    { name: "google:calendar:events", commands: [{ name: "list", execute: ["echo"], help: { text: "List events" } }, { name: "delete", execute: ["echo"], help: { text: "Delete an event" } }] },
    { name: "google:gmail", commands: [{ name: "list", execute: ["echo"], help: { text: "List messages" } }] },
    { name: "browser", commands: [{ name: "open", execute: ["echo"], help: { text: "Open a page" } }] },
    { name: "db", commands: [{ name: "list", execute: ["echo"], help: { text: "List tables" } }] },
    { name: "validator", commands: [{ name: "validate", execute: ["echo"], help: { text: "Validate a value" } }] },
    { name: "computer", commands: [{ name: "open", execute: ["echo"], help: { text: "Open an app, a file or a URL" } }, { name: "focus", execute: ["echo"], help: { text: "Bring a running application to the foreground" } }] }
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-index-"));
  const file = path.join(dir, "global.aux4");
  fs.writeFileSync(file, JSON.stringify({ profiles }));
  return file;
}

// Runs fn with AUX4_INSTALLED_APPS set to a fixed, deterministic app list
// (bypassing the real OS scan and its disk cache), then restores the env.
function withInstalledApps(apps, fn) {
  const prior = process.env.AUX4_INSTALLED_APPS;
  process.env.AUX4_INSTALLED_APPS = apps.join(",");
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.AUX4_INSTALLED_APPS;
    else process.env.AUX4_INSTALLED_APPS = prior;
  }
}

test("loadGroups walks profile routes into command groups", () => {
  const paths = loadGroups(fixture()).map(g => g.path).sort();
  assert.deepEqual(paths, ["browser", "calendar", "computer", "db", "google calendar events", "google gmail", "validator"]);
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

test("a request naming an installed app surfaces aux4 computer, not a suffix-stemmed unrelated group", () => {
  withInstalledApps(["Calculator"], () => {
    const paths = matchGroups("open the calculator and do 10 times 8", loadGroups(fixture())).map(g => g.path);
    assert.ok(paths.includes("computer"), `expected "computer" in ${JSON.stringify(paths)}`);
    assert.ok(!paths.includes("validator"), `"calculator" must not spuriously match "validator" via suffix stemming: ${JSON.stringify(paths)}`);
  });
});

test("a request naming a different installed app also surfaces aux4 computer, generically", () => {
  withInstalledApps(["Calculator", "Safari", "Notes"], () => {
    const paths = matchGroups("use Safari to look something up", loadGroups(fixture())).map(g => g.path);
    assert.ok(paths.includes("computer"));
  });
});

test("no installed app named in the request leaves computer out, and non-app requests are unaffected", () => {
  withInstalledApps(["Calculator", "Safari", "Notes"], () => {
    const paths = matchGroups("Cancel the Budget review meeting on my calendar", loadGroups(fixture())).map(g => g.path);
    assert.ok(!paths.includes("computer"));
    assert.ok(paths.includes("calendar"));
  });
});

test("AUX4_INSTALLED_APPS overrides the OS scan for installedAppNames", () => {
  withInstalledApps(["Foo Bar", "Baz"], () => {
    assert.deepEqual(installedAppNames(), ["Foo Bar", "Baz"]);
  });
});

test("the suffix-stemming exception no longer treats -ator/-itor endings as related", () => {
  withInstalledApps([], () => {
    const paths = matchGroups("open the calculator", loadGroups(fixture())).map(g => g.path);
    assert.ok(!paths.includes("validator"), `calculator must not match validator via the -ator suffix: ${JSON.stringify(paths)}`);
  });
});
