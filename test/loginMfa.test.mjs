import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const api = await import("../src/api.js");
const storage = await import("../src/storage.js");

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    const [status, body] = handler(String(url), init);
    return new Response(body == null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test("every request carries the same install device ID", async () => {
  const calls = stubFetch(() => [200, {}]);
  await storage.setToken("tok");
  await api.getProfile();
  await api.getSettings();
  const ids = calls.map((c) => c.init.headers["X-NAO-Device"]);
  assert.match(ids[0], /^[0-9a-f]{32}$/);
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[0], (await chrome.storage.local.get("naoDeviceId")).naoDeviceId);
});

test("an account with two-step sign-in returns a ticket, then the code signs in", async () => {
  const calls = stubFetch((url) => {
    if (url.endsWith("/auth/login")) return [200, { success: true, mfa_required: true, mfa_ticket: "t-1", email: "pat@example.com" }];
    if (url.endsWith("/auth/login/mfa")) return [200, { success: true, access_token: "session-1", user_id: "u1", email: "pat@example.com" }];
    return [404, null];
  });
  const first = await api.login("pat@example.com", "Correct-horse-42");
  assert.deepEqual(first, { mfaTicket: "t-1", email: "pat@example.com" });
  assert.equal(await storage.getToken(), null, "no session before the code");
  const body = calls[0].body;
  assert.equal(body.mfa_capable, true);
  assert.equal(body.long_lived, true);
  assert.match(body.client.app, /^extension\//);

  const user = await api.loginWithCode("t-1", "123456");
  assert.deepEqual(user, { user_id: "u1", email: "pat@example.com" });
  assert.equal(await storage.getToken(), "session-1");
  assert.deepEqual(calls[1].body, { ticket: "t-1", code: "123456" });
});

test("a wrong code shows the server's message", async () => {
  stubFetch(() => [401, { detail: "That code didn't work. Check that your phone's time is set automatically, then try again." }]);
  await assert.rejects(api.loginWithCode("t-1", "000000"), /code didn't work/);
});

test("accounts without two-step sign in directly", async () => {
  stubFetch(() => [200, { success: true, access_token: "session-2", user_id: "u2", email: "kim@example.com" }]);
  const user = await api.login("kim@example.com", "Correct-horse-42");
  assert.equal(user.user_id, "u2");
  assert.equal(await storage.getToken(), "session-2");
});
