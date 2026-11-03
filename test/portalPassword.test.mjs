import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.window ??= { screen: { width: 1920, height: 1080 } };
globalThis.navigator ??= { userAgent: "node", language: "en-US" };

const storage = await import("../src/storage.js");
const { portalPasswordForNewAccount } = await import("../src/panel/autofill/shared.js");

function respond(status, body) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test("new portal accounts use the password saved in Preferences", async () => {
  await storage.setToken("tok");
  const calls = respond(200, { password: "Mine#2026x" });
  assert.equal(await portalPasswordForNewAccount(), "Mine#2026x");
  assert.match(calls[0], /\/profile\/portal-password\/secret$/);
});

test("without a saved password, a strong one is generated", async () => {
  await storage.setToken("tok");
  respond(200, { password: null });
  const generated = await portalPasswordForNewAccount();
  assert.ok(generated.length >= 12);
  assert.match(generated, /[a-z]/);
  assert.match(generated, /[A-Z]/);
  assert.match(generated, /\d/);
  assert.match(generated, /[^A-Za-z0-9]/);
});

test("a server error still yields a generated password", async () => {
  await storage.setToken("tok");
  respond(500, { detail: "boom" });
  const generated = await portalPasswordForNewAccount();
  assert.ok(generated.length >= 12);
});
