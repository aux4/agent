#!/usr/bin/env node

// Invoke the dedicated builder VM directly from a cloud agent. A cloud VM does
// not have a human login or aux4-pkger, so going through `aux4 cloud` makes a
// valid request-scoped credential look like "not logged in". The control plane
// exchanges that credential for a short-lived machine token on the 307 hop.

import { URL } from "node:url";

const MACHINE_TOKEN = "X-Aux4-Invoke-Token";
const FUNCTION_HOST = /^[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws$/;

function fail(message) {
  process.stderr.write(`${String(message || "builder request failed").slice(0, 300)}\n`);
  process.exitCode = 1;
}

function validRedirect(location, endpoint) {
  try {
    const target = new URL(location);
    const control = new URL(endpoint);
    return target.origin === control.origin
      || (target.protocol === "https:" && FUNCTION_HOST.test(target.hostname));
  } catch {
    return false;
  }
}

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function main() {
  const [apiUrl = "https://api.aux4.cloud", scope = "", vm = "builder", timeoutArg = "120000"] = process.argv.slice(2);
  const token = String(process.env.AGENT_BUILDER_ACCESS_TOKEN || process.env.AUX4_ACCESS_TOKEN || "")
    .replace(/^Bearer\s+/i, "").trim();
  if (!token) return fail("builder request has no caller token");
  if (!scope || !vm) return fail("builder scope and VM are required");

  const endpoint = `${String(apiUrl).replace(/\/$/, "")}/v1/${encodeURIComponent(scope)}/run/${encodeURIComponent(vm)}/generate`;
  const stdin = await readStdin();
  const body = JSON.stringify({ stdin });
  const timeoutMs = Math.max(1000, Math.min(300000, Number.parseInt(timeoutArg, 10) || 120000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status === 307) {
      const location = response.headers.get("location") || "";
      const invokeToken = response.headers.get(MACHINE_TOKEN) || "";
      if (!location || !invokeToken || !validRedirect(location, endpoint)) {
        return fail("builder returned an invalid machine redirect");
      }
      response = await fetch(location, {
        method: "POST",
        headers: { "content-type": "application/json", [MACHINE_TOKEN]: invokeToken },
        body,
        redirect: "error",
        signal: controller.signal
      });
    }
    const text = await response.text();
    if (!response.ok) return fail(text || `builder request failed (${response.status})`);
    let value;
    try { value = JSON.parse(text); } catch { value = null; }
    const output = value && typeof value === "object" && typeof value.output === "string"
      ? value.output
      : value && typeof value === "object" && typeof value.body === "string"
        ? value.body
        : text;
    process.stdout.write(output);
  } catch (error) {
    fail(error?.name === "AbortError" ? "builder request timed out" : error?.message || error);
  } finally {
    clearTimeout(timer);
  }
}

main().catch(error => fail(error?.message || error));
