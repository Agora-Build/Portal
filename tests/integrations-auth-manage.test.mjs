import { test } from "node:test";
import assert from "node:assert/strict";
import { createManageClient, ManageError } from "../scripts/integrations/auth-manage.mjs";

const issuer = "https://auth.example";
const clientId = "portal";
const clientSecret = "s3cret+with:colon and space".padEnd(40, "x");
const actor = "ab0123456789ABCDEFGHJKMNPQ";
const other = "abZZZZZZZZZZZZZZZZZZZZZZZZ";

function stub(...replies) {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, ...options, headers: new Headers(options.headers) });
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    if (typeof reply === "function") return reply(url, options);
    return reply instanceof Response ? reply.clone() : Response.json(reply);
  };
  return { calls, request };
}
const clientWith = (s, options = {}) => createManageClient({ issuer, clientId, clientSecret, request: s.request, ...options });
const formEncode = (value) => encodeURIComponent(value).replace(/%20/g, "+");

test("the Basic header form-encodes the id and secret (RFC 6749 2.3.1)", async () => {
  const s = stub({ stations: [] });
  await clientWith(s).stations(actor);
  const expected = "Basic " + Buffer.from(formEncode(clientId) + ":" + formEncode(clientSecret)).toString("base64");
  assert.equal(s.calls[0].headers.get("authorization"), expected);
  assert.match(Buffer.from(expected.slice(6), "base64").toString(), /s3cret%2Bwith%3Acolon\+and\+space/);
});

test("URLs, methods and bodies follow the management API", async () => {
  const s = stub(new Response(null, { status: 204 }));
  const client = clientWith(s, { issuer: issuer + "/" });
  const base = issuer + "/manage/v1";
  await client.removeStation("st/1", actor);
  await client.addMember("st 1", other, actor);
  await client.removeMember("st1", other, actor);
  assert.deepEqual(s.calls.map((c) => [c.method, c.url]), [
    ["DELETE", base + "/stations/st%2F1?actor=" + actor],
    ["PUT", base + "/stations/st%201/members/" + other + "?actor=" + actor],
    ["DELETE", base + "/stations/st1/members/" + other + "?actor=" + actor]
  ]);
  for (const call of s.calls) {
    assert.equal(call.body, undefined);
    assert.equal(call.headers.has("content-type"), false);
  }
});

test("reads parse JSON and 204 is undefined", async () => {
  const station = { id: "s1", origin: "https://st.example", owner: actor, status: "active", reportClientId: "s-x", createdAt: "2026-10-24T00:00:00Z" };
  let s = stub({ stations: [station] });
  assert.deepEqual(await clientWith(s).stations(actor), [station]);
  assert.equal(s.calls[0].method, "GET");
  assert.equal(s.calls[0].url, issuer + "/manage/v1/stations?account=" + actor);
  s = stub({ integrations: [{ clientId: "i-1" }] });
  assert.deepEqual(await clientWith(s).integrations(actor), [{ clientId: "i-1" }]);
  assert.equal(s.calls[0].url, issuer + "/manage/v1/integrations?account=" + actor);
  s = stub({ owner: actor, members: [{ account: other, addedAt: "t" }] });
  assert.deepEqual(await clientWith(s).members("s1", actor), { owner: actor, members: [{ account: other, addedAt: "t" }] });
  assert.equal(s.calls[0].url, issuer + "/manage/v1/stations/s1/members?actor=" + actor);
  s = stub(new Response(null, { status: 204 }));
  assert.equal(await clientWith(s).addMember("s1", other, actor), undefined);
});

test("writes send JSON with a UTF-8 content type and the actor", async () => {
  let s = stub(Response.json({ id: "s1", origin: "https://st.example", owner: actor, status: "active", reportClientId: "s-x" }, { status: 201 }));
  const reportKey = { kty: "EC" };
  assert.equal((await clientWith(s).registerStation({ origin: "https://st.example", owner: actor, reportKey, actor })).id, "s1");
  assert.equal(s.calls[0].method, "POST");
  assert.equal(s.calls[0].url, issuer + "/manage/v1/stations");
  assert.equal(s.calls[0].headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(s.calls[0].body), { origin: "https://st.example", owner: actor, reportKey, actor });

  s = stub(Response.json({ clientId: "i-1", status: "active", expiresAt: "t" }, { status: 201 }));
  const publicJwk = { kty: "EC", crv: "P-256" };
  await clientWith(s).createIntegration({ owner: actor, stationId: "s1", name: "Bot", scopes: ["agent.view"], publicJwk, quotaPerSecond: 50, actor });
  assert.equal(s.calls[0].url, issuer + "/manage/v1/integrations");
  assert.deepEqual(JSON.parse(s.calls[0].body), { owner: actor, stationId: "s1", name: "Bot", scopes: ["agent.view"], publicJwk, quotaPerSecond: 50, actor });

  s = stub(Response.json({ kid: "k", overlapEndsAt: "t" }, { status: 201 }));
  assert.deepEqual(await clientWith(s).addKey("i-1", publicJwk, actor), { kid: "k", overlapEndsAt: "t" });
  assert.equal(s.calls[0].url, issuer + "/manage/v1/integrations/i-1/keys");
  assert.deepEqual(JSON.parse(s.calls[0].body), { publicJwk, actor });

  s = stub({ clientId: "i-1", status: "paused" });
  assert.equal((await clientWith(s).changeIntegration("i-1", { status: "paused" }, actor)).status, "paused");
  assert.equal(s.calls[0].method, "PATCH");
  assert.equal(s.calls[0].url, issuer + "/manage/v1/integrations/i-1");
  assert.deepEqual(JSON.parse(s.calls[0].body), { status: "paused", actor });
});

test("Auth errors become ManageError with Auth's code, never echoing the request", async () => {
  const s = stub(Response.json({ error: "forbidden", error_description: "no" }, { status: 403 }));
  await assert.rejects(clientWith(s).changeIntegration("i-1", { r9Svc: "a".repeat(64) }, actor), (error) => {
    assert.ok(error instanceof ManageError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "forbidden");
    assert.ok(!error.message.includes(clientSecret) && !error.message.includes("a".repeat(64)));
    return true;
  });
});

test("network failures, timeouts, non-JSON 5xx and bad 2xx bodies are classified", async () => {
  const unavailable = (error) => error instanceof ManageError && error.status === 503 && error.code === "unavailable";
  await assert.rejects(clientWith(stub(() => { throw new TypeError("fetch failed"); })).stations(actor), unavailable);
  // AbortSignal.timeout's timer is unref'd, so a ref'd timer keeps the test process alive until it fires.
  const hang = (url, options) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 5000);
    options.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(options.signal.reason); });
  });
  await assert.rejects(clientWith(stub(hang), { timeoutMs: 20 }).stations(actor), unavailable);
  await assert.rejects(clientWith(stub(new Response("<html>oops</html>", { status: 500 }))).stations(actor), unavailable);
  await assert.rejects(clientWith(stub(new Response("not json", { status: 200 }))).stations(actor), (error) => error instanceof ManageError && error.code === "bad_response");
  await assert.rejects(clientWith(stub({ nope: 1 })).stations(actor), (error) => error instanceof ManageError && error.code === "bad_response");
});

test("bad settings are refused", () => {
  assert.throws(() => createManageClient({ issuer: "ftp://auth.example", clientId, clientSecret }), TypeError);
  assert.throws(() => createManageClient({ issuer: "nope", clientId, clientSecret }), TypeError);
  assert.throws(() => createManageClient({ issuer, clientId, clientSecret: "short" }), TypeError);
  assert.throws(() => createManageClient({ issuer, clientId: "", clientSecret }), TypeError);
});
