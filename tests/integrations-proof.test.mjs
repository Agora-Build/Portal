import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import https from "node:https";
import { AppError } from "../scripts/store.mjs";
import { blockedAddress, checkProof, createStationFetch, ProofError, stationOrigin } from "../scripts/integrations/proof.mjs";

const tls = {
  key: readFileSync(new URL("./fixtures/tls/station-test.key", import.meta.url)),
  cert: readFileSync(new URL("./fixtures/tls/station-test.crt", import.meta.url))
};
const ORIGIN_MESSAGE = "Enter the Station's address as https://host, without a path.";
const VALUE = "abps_0123456789abcdefghijklmnopqrstuvwxyzABCDEF";

test("stationOrigin accepts bare https origins and normalises them", () => {
  assert.equal(stationOrigin("https://station.example"), "https://station.example");
  assert.equal(stationOrigin("https://station.example/"), "https://station.example");
  assert.equal(stationOrigin("https://Station.Example"), "https://station.example");
  assert.equal(stationOrigin("https://station.example:8443"), "https://station.example:8443");
});

test("stationOrigin refuses anything that is not a bare https origin with a DNS name", () => {
  const refused = [
    "http://station.example",
    "https://station.example/path",
    "https://station.example?x",
    "https://station.example#f",
    "https://u:p@station.example",
    "https://u@station.example",
    "https://localhost",
    "https://10.0.0.1",
    "https://127.1",
    "https://[::1]",
    "https://[2001:db8::1]",
    "https://station.example ",
    " https://station.example",
    "https://station.example//",
    "https://station.example.",
    "https://station.example:0",
    "",
    "https://" + "a".repeat(300) + ".example",
    "not a url",
    undefined,
    null,
    42,
    { toString: () => "https://station.example" }
  ];
  for (const value of refused) {
    assert.throws(() => stationOrigin(value), (error) => {
      assert.ok(error instanceof AppError, String(value));
      assert.equal(error.status, 400);
      assert.equal(error.message, ORIGIN_MESSAGE);
      return true;
    }, String(value));
  }
});

test("blockedAddress covers each refused range at its edges", () => {
  const table = [
    ["0.0.0.0", 4, true], ["0.255.255.255", 4, true], ["1.0.0.0", 4, false],
    ["9.255.255.255", 4, false], ["10.0.0.0", 4, true], ["10.255.255.255", 4, true], ["11.0.0.0", 4, false],
    ["100.63.255.255", 4, false], ["100.64.0.1", 4, true], ["100.127.255.255", 4, true], ["100.128.0.0", 4, false],
    ["126.255.255.255", 4, false], ["127.0.0.1", 4, true], ["127.255.255.255", 4, true], ["128.0.0.0", 4, false],
    ["169.253.255.255", 4, false], ["169.254.0.0", 4, true], ["169.254.169.254", 4, true], ["169.255.0.0", 4, false],
    ["172.15.255.255", 4, false], ["172.16.0.0", 4, true], ["172.31.255.255", 4, true], ["172.32.0.0", 4, false],
    ["191.255.255.255", 4, false], ["192.0.0.0", 4, true], ["192.0.0.255", 4, true], ["192.0.1.0", 4, false],
    ["192.167.255.255", 4, false], ["192.168.0.0", 4, true], ["192.168.255.255", 4, true], ["192.169.0.0", 4, false],
    ["198.17.255.255", 4, false], ["198.18.0.0", 4, true], ["198.19.255.255", 4, true], ["198.20.0.0", 4, false],
    ["223.255.255.255", 4, false], ["224.0.0.0", 4, true], ["239.255.255.255", 4, true],
    ["240.0.0.0", 4, true], ["255.255.255.254", 4, true], ["255.255.255.255", 4, true],
    ["8.8.8.8", 4, false], ["93.184.216.34", 4, false],
    ["::", 6, true], ["::1", 6, true], ["::2", 6, true], ["::1:0:0", 6, false],
    ["fbff:ffff::1", 6, false], ["fc00::", 6, true], ["fd00::1", 6, true], ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", 6, true], ["fe00::", 6, false],
    ["fe7f:ffff::1", 6, false], ["fe80::1", 6, true], ["fe80::1%eth0", 6, true], ["febf:ffff::1", 6, true], ["fec0::1", 6, false],
    ["feff:ffff::1", 6, false], ["ff00::", 6, true], ["ff02::1", 6, true], ["FF02::1", 6, true],
    ["::ffff:127.0.0.1", 6, true], ["::ffff:7f00:1", 6, true], ["::ffff:10.1.2.3", 6, true], ["::ffff:8.8.8.8", 6, false],
    ["::7f00:1", 6, true], ["::8.8.8.8", 6, true], ["::ffff:0:8.8.8.8", 6, true],
    ["64:ff9b::127.0.0.1", 6, true], ["64:ff9b::a00:1", 6, true], ["64:ff9b::8.8.8.8", 6, false], ["64:ff9b:1::1", 6, false],
    ["2001:db8::1", 6, false], ["2606:4700:4700::1111", 6, false],
    ["127.0.0.1", "IPv4", true], ["8.8.8.8", undefined, false], ["::1", "IPv6", true],
    ["not-an-address", 4, true], ["", 6, true], [undefined, 4, true]
  ];
  for (const [address, family, expected] of table) assert.equal(blockedAddress(address, family), expected, String(address));
});

async function station(t, handler) {
  const seen = [];
  let connections = 0;
  const server = https.createServer(tls, (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      handler(request, response, body);
    });
  });
  server.on("secureConnection", () => { connections += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = "https://station.test:" + server.address().port;
  return { origin, seen, connections: () => connections };
}

// A lookup stub that answers in whichever shape Node asks for (single address, or `all: true` lists).
function lookupTo(...addresses) {
  const calls = [];
  const lookup = (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    calls.push({ hostname, all: Boolean(options?.all) });
    const entries = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    process.nextTick(() => options?.all ? callback(null, entries) : callback(null, entries[0].address, entries[0].family));
  };
  return { calls, lookup };
}
const testAgent = () => new https.Agent({ rejectUnauthorized: false });
const testFetch = (options = {}) => createStationFetch({ allowPrivate: true, lookup: lookupTo("127.0.0.1").lookup, agent: testAgent(), ...options });

const WELL_KNOWN = "/.well-known/agora-build-station";
const replyWith = (status, body, headers = {}) => (request, response) => { response.writeHead(status, { "Content-Type": "text/plain", ...headers }); response.end(body); };

test("an exact proof body passes and the fetch asks the well-known path with SNI", async (t) => {
  const s = await station(t, replyWith(200, VALUE));
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: testFetch() }), { ok: true });
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0].method, "GET");
  assert.equal(s.seen[0].url, WELL_KNOWN);
  assert.equal(s.seen[0].headers.host, "station.test:" + s.origin.split(":").pop());
});

test("one trailing newline passes; anything else is a mismatch", async (t) => {
  for (const [body, expected] of [
    [VALUE + "\n", { ok: true }],
    [VALUE + "\r\n", { ok: false, reason: "mismatch" }],
    [" " + VALUE, { ok: false, reason: "mismatch" }],
    [VALUE + "\n\n", { ok: false, reason: "mismatch" }],
    [VALUE.slice(1), { ok: false, reason: "mismatch" }],
    ["", { ok: false, reason: "mismatch" }]
  ]) {
    const s = await station(t, replyWith(200, body));
    assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: testFetch() }), expected, JSON.stringify(body));
  }
});

test("a redirect is reported as its status and never followed", async (t) => {
  const s = await station(t, (request, response) => {
    if (request.url !== WELL_KNOWN) { response.writeHead(200); response.end(VALUE); return; }
    response.writeHead(302, { Location: "/elsewhere" });
    response.end();
  });
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: testFetch() }), { ok: false, reason: "status_302" });
  assert.deepEqual(s.seen.map((entry) => entry.url), [WELL_KNOWN]);
});

test("a non-200 status is reported as status_<code>", async (t) => {
  const s = await station(t, replyWith(404, "not here"));
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: testFetch() }), { ok: false, reason: "status_404" });
});

test("a body over 1024 bytes is too_large; exactly 1024 bytes is read", async (t) => {
  const big = await station(t, replyWith(200, "x".repeat(2000)));
  assert.deepEqual(await checkProof(big.origin, VALUE, { fetch: testFetch() }), { ok: false, reason: "too_large" });
  const edge = await station(t, replyWith(200, "x".repeat(1024)));
  const { status, body } = await testFetch().get(edge.origin + WELL_KNOWN);
  assert.equal(status, 200);
  assert.equal(body.length, 1024);
  const over = await station(t, replyWith(200, "x".repeat(1025)));
  await assert.rejects(testFetch().get(over.origin + WELL_KNOWN), (error) => error instanceof ProofError && error.reason === "too_large");
});

test("a Station that never answers times out at timeoutMs", async (t) => {
  const s = await station(t, () => {});
  const started = Date.now();
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: testFetch({ timeoutMs: 200 }) }), { ok: false, reason: "timeout" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 1500, "elapsed " + elapsed);
});

test("a private resolved address is refused before connecting, in either lookup shape", async (t) => {
  const s = await station(t, replyWith(200, VALUE));
  for (const addresses of [["127.0.0.1"], ["8.8.8.8", "127.0.0.1"], ["::1"], ["::ffff:127.0.0.1"], ["169.254.169.254"]]) {
    const stub = lookupTo(...addresses);
    const fetch = createStationFetch({ lookup: stub.lookup, agent: testAgent() });
    assert.deepEqual(await checkProof(s.origin, VALUE, { fetch }), { ok: false, reason: "blocked_address" }, addresses.join(","));
    assert.ok(stub.calls.length >= 1);
    assert.equal(stub.calls[0].hostname, "station.test");
  }
  assert.equal(s.connections(), 0);
  assert.equal(s.seen.length, 0);
});

test("the guarded lookup answers both callback shapes it is asked for", async (t) => {
  const s = await station(t, replyWith(200, VALUE));
  const single = (hostname, options, callback) => { if (typeof options === "function") callback = options; callback(null, "127.0.0.1", 4); };
  const listed = (hostname, options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
  for (const lookup of [single, listed]) {
    assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: createStationFetch({ allowPrivate: true, lookup, agent: testAgent() }) }), { ok: true });
    assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: createStationFetch({ lookup, agent: testAgent() }) }), { ok: false, reason: "blocked_address" });
  }
  const failing = (hostname, options, callback) => { (typeof options === "function" ? options : callback)(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })); };
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: createStationFetch({ lookup: failing, agent: testAgent() }) }), { ok: false, reason: "network" });
  const empty = (hostname, options, callback) => callback(null, []);
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: createStationFetch({ lookup: empty, agent: testAgent() }) }), { ok: false, reason: "network" });
});

test("IP-literal and non-https URLs are refused without any lookup", async () => {
  const stub = lookupTo("8.8.8.8");
  const fetch = createStationFetch({ allowPrivate: true, lookup: stub.lookup, agent: testAgent() });
  for (const url of ["https://127.0.0.1/x", "https://[::1]/x", "https://8.8.8.8/x", "http://station.test/x"]) {
    await assert.rejects(fetch.get(url), (error) => error instanceof ProofError && error.reason === "blocked_address", url);
    await assert.rejects(fetch.post(url, {}), (error) => error instanceof ProofError && error.reason === "blocked_address", url);
  }
  assert.equal(stub.calls.length, 0);
});

test("an untrusted certificate is a network failure without the test agent", async (t) => {
  const s = await station(t, replyWith(200, VALUE));
  const fetch = createStationFetch({ allowPrivate: true, lookup: lookupTo("127.0.0.1").lookup });
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch }), { ok: false, reason: "network" });
});

test("an empty or non-string proof value is a TypeError and fetches nothing", async (t) => {
  const s = await station(t, replyWith(200, "undefined\n"));
  for (const value of [undefined, null, "", 42]) {
    await assert.rejects(checkProof(s.origin, value, { fetch: testFetch() }), TypeError, String(value));
  }
  assert.equal(s.connections(), 0);
  assert.equal(s.seen.length, 0);
});

test("a body dripping slower than timeoutMs still times out", async (t) => {
  const s = await station(t, (request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    const drip = setInterval(() => response.write("x"), 50);
    response.on("close", () => clearInterval(drip));
  });
  const started = Date.now();
  assert.deepEqual(await checkProof(s.origin, VALUE, { fetch: testFetch({ timeoutMs: 200 }) }), { ok: false, reason: "timeout" });
  assert.ok(Date.now() - started < 1500);
});

test("post sends JSON and returns the status, with the same safety", async (t) => {
  const s = await station(t, replyWith(202, "accepted"));
  assert.deepEqual(await testFetch().post(s.origin + "/nudge", { changed: true }), { status: 202 });
  assert.equal(s.seen[0].method, "POST");
  assert.equal(s.seen[0].url, "/nudge");
  assert.match(s.seen[0].headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(s.seen[0].body), { changed: true });

  const redirect = await station(t, replyWith(307, "", { Location: "/elsewhere" }));
  assert.deepEqual(await testFetch().post(redirect.origin + "/nudge", {}), { status: 307 });
  assert.deepEqual(redirect.seen.map((entry) => entry.url), ["/nudge"]);

  const silent = await station(t, () => {});
  await assert.rejects(testFetch({ timeoutMs: 200 }).post(silent.origin + "/nudge", {}), (error) => error instanceof ProofError && error.reason === "timeout");

  const guarded = await station(t, replyWith(202, ""));
  await assert.rejects(createStationFetch({ lookup: lookupTo("10.0.0.5").lookup, agent: testAgent() }).post(guarded.origin + "/nudge", {}),
    (error) => error instanceof ProofError && error.reason === "blocked_address");
  assert.equal(guarded.connections(), 0);
});

test("ProofError carries its reason", () => {
  const error = new ProofError("timeout");
  assert.ok(error instanceof Error);
  assert.equal(error.reason, "timeout");
});
