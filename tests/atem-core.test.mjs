// The Portal signs Agora tokens with Atem's atem-core (the library Astation uses), compiled to WebAssembly with zlib as
// Astation builds it. These tests pin the module to Astation's Atem revision and rebuild Astation's eight captured
// tokens byte for byte (Astation's TokenLibraryInteropTests). Atem's published vector and Agora's own JavaScript
// builder (agora-token) are compared by signed content: the vector was compressed with atem-core's default
// miniz_oxide, and agora-token with Node's bundled zlib, which compresses differently from standard zlib.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import test from "node:test";
import agoraToken from "agora-token";
import { TokenError, buildRtcToken, buildRtmToken, decodeToken, verifyTokenSignature } from "../scripts/atem-core.mjs";

const read = (path) => readFile(new URL("../" + path, import.meta.url));
// Agora's public test values, as in Atem's own tests; not real credentials.
const APP_ID = "970CA35de60c44645bbae8a215061b33", CERT = "5CFd2fd1755d40ecb72977518be15d3b", CHANNEL = "7d72365eb983485397e3e3f9d460bdda";
// Astation's Config/atem-core.json revision.
const ASTATION_ATEM_REVISION = "929909e9506d95e555779b9c58163f762e962cd1";
const { RtcTokenBuilder, RtcRole, RtmTokenBuilder } = agoraToken;
const same = (upstream) => { const decoded = decodeToken(upstream); return { issuedAt: decoded.issued_at, salt: decoded.salt }; };
// The signed content of an AccessToken2: everything after "007", decompressed.
const content = (token) => inflateSync(Buffer.from(token.slice(3), "base64"));

test("the module is the committed build of Atem at Astation's revision, exporting C ABI 1 only", async () => {
  const manifest = JSON.parse(await read("scripts/vendor/atem-core.json"));
  const wasm = await read("scripts/vendor/atem-core.wasm");
  assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.sha256, "rebuild with npm run build:atem-core");
  assert.equal(manifest.atemRevision, ASTATION_ATEM_REVISION);
  assert.equal(manifest.abiVersion, 1);
  assert.equal(manifest.compression, "zlib (as Astation)");
  assert.match(String(await read("native/atem-core-wasm/Cargo.toml")), new RegExp('atem-core-ffi = \\{ git = "https://github.com/Agora-Build/Atem.git", rev = "' + ASTATION_ATEM_REVISION + '" \\}'));
  const module = new WebAssembly.Module(wasm);
  const exported = WebAssembly.Module.exports(module).map((entry) => entry.name).filter((name) => name.startsWith("atem_core_")).sort();
  assert.deepEqual(exported, ["atem_core_abi_version", "atem_core_build_rtc_token", "atem_core_build_rtm_token", "atem_core_decode_token", "atem_core_string_free", "atem_core_verify_token_signature", "atem_core_version"]);
  assert.deepEqual(WebAssembly.Module.imports(module).map((entry) => entry.module + "." + entry.name), ["env.portal_random"], "no clock, file or network access");
});

test("it rebuilds Astation's eight captured tokens byte for byte", async () => {
  // Astation Tests/AstationTests/Fixtures/token-compatibility.json, captured from its original C++ builder, with the
  // App ID and certificate its TokenLibraryInteropTests use.
  const app = "0123456789abcdef0123456789abcdef", certificate = "abcdef0123456789abcdef0123456789";
  const fixtures = JSON.parse(await read("tests/fixtures/astation-token-compatibility.json"));
  assert.equal(fixtures.length, 8);
  for (const { name, token } of fixtures) {
    const decoded = decodeToken(token), service = decoded.services[0], issue = { issuedAt: decoded.issued_at, salt: decoded.salt };
    const rebuilt = service.service_type === 1
      ? buildRtcToken({ appId: app, certificate, channel: service.details.channel, uid: service.details.account ? Number(service.details.account) : 0, role: Object.keys(service.privileges).length === 1 ? "subscriber" : "publisher", tokenExpire: decoded.expire, privilegeExpire: service.privileges["1"], ...issue })
      : buildRtmToken({ appId: app, certificate, userId: service.details.user_id, expire: decoded.expire, ...issue });
    assert.equal(rebuilt, token, name);
    assert.equal(verifyTokenSignature(token, certificate), true, name);
  }
});

test("it signs the same content as Atem's published vector", () => {
  const vector = "007eJwBigB1/yAAFqC4TFpegsv3T7gT0J9ZxUvaycBhIFgFOayXV46VixogADk3MENBMzVkZTYwYzQ0NjQ1YmJhZThhMjE1MDYxYjMzR/QQAFgCAAABAAAAAQABAAEAAQBYAgAAIAA3ZDcyMzY1ZWI5ODM0ODUzOTdlM2UzZjlkNDYwYmRkYQoAMjg4MjM0MTI3M8JqJOM=";
  const token = buildRtcToken({ appId: APP_ID, certificate: CERT, channel: CHANNEL, uid: 2882341273, role: "subscriber", tokenExpire: 600, privilegeExpire: 600, issuedAt: 1111111, salt: 1 });
  assert.deepEqual(content(token), content(vector));
  assert.equal(verifyTokenSignature(vector, CERT), true);
});

test("it signs what Agora's own builder signs for RTC (UID, UID 0, maximum UID, account, explicit, with RTM) and RTM", () => {
  const cases = [
    ["uid publisher", RtcTokenBuilder.buildTokenWithUid(APP_ID, CERT, CHANNEL, 2882341273, RtcRole.PUBLISHER, 3600, 1800), { uid: 2882341273, role: "publisher", tokenExpire: 3600, privilegeExpire: 1800 }],
    ["uid subscriber", RtcTokenBuilder.buildTokenWithUid(APP_ID, CERT, CHANNEL, 2882341273, RtcRole.SUBSCRIBER, 3600, 1800), { uid: 2882341273, role: "subscriber", tokenExpire: 3600, privilegeExpire: 1800 }],
    ["uid 0", RtcTokenBuilder.buildTokenWithUid(APP_ID, CERT, CHANNEL, 0, RtcRole.PUBLISHER, 600, 600), { uid: 0, role: "publisher", tokenExpire: 600, privilegeExpire: 600 }],
    ["maximum uid", RtcTokenBuilder.buildTokenWithUid(APP_ID, CERT, CHANNEL, 4294967295, RtcRole.PUBLISHER, 600, 600), { uid: 4294967295, role: "publisher", tokenExpire: 600, privilegeExpire: 600 }],
    ["account", RtcTokenBuilder.buildTokenWithUserAccount(APP_ID, CERT, CHANNEL, "builder_42", RtcRole.PUBLISHER, 3600, 3600), { account: "builder_42", role: "publisher", tokenExpire: 3600, privilegeExpire: 3600 }],
    ["explicit", RtcTokenBuilder.buildTokenWithUidAndPrivilege(APP_ID, CERT, CHANNEL, 7, 900, 600, 300, 200, 100), { uid: 7, role: "explicit", tokenExpire: 900, join: 600, audio: 300, video: 200, data: 100 }],
    ["with rtm", RtcTokenBuilder.buildTokenWithRtm(APP_ID, CERT, CHANNEL, "builder_42", RtcRole.PUBLISHER, 3600, 3600), { account: "builder_42", role: "publisher", tokenExpire: 3600, privilegeExpire: 3600, rtm: { expire: 3600 } }]
  ];
  for (const [label, upstream, request] of cases) assert.deepEqual(content(buildRtcToken({ appId: APP_ID, certificate: CERT, channel: CHANNEL, ...request, ...same(upstream) })), content(upstream), label);
  const rtm = RtmTokenBuilder.buildToken(APP_ID, CERT, "alice", 3600);
  assert.deepEqual(content(buildRtmToken({ appId: APP_ID, certificate: CERT, userId: "alice", expire: 3600, ...same(rtm) })), content(rtm));
});

test("tokens decode and verify; fresh tokens use the clock and a salt in Agora's range", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = buildRtcToken({ appId: APP_ID, certificate: CERT, channel: "demo", account: "u", rtm: { userId: "other", expire: 60 } });
  const decoded = decodeToken(token);
  assert.ok(decoded.issued_at >= before && decoded.issued_at <= before + 2);
  assert.ok(decoded.salt >= 1 && decoded.salt <= 99999998);
  assert.deepEqual(decoded.services.map((service) => service.details), [{ kind: "rtc", channel: "demo", account: "u" }, { kind: "rtm", user_id: "other" }]);
  assert.equal(verifyTokenSignature(token, CERT), true);
  assert.equal(verifyTokenSignature(token, "0".repeat(32)), false);
  assert.notEqual(buildRtmToken({ appId: APP_ID, certificate: CERT, userId: "a" }), buildRtmToken({ appId: APP_ID, certificate: CERT, userId: "a" }), "salts differ");
});

test("invalid inputs fail with Astation's wording and never echo the inputs", () => {
  const secret = "abcdef0123456789abcdef012345678Z";
  const cases = [
    [{ appId: "not-an-app-id", certificate: CERT, channel: "c" }, 10],
    [{ appId: APP_ID, certificate: secret, channel: "c" }, 11],
    [{ appId: APP_ID, certificate: CERT, channel: "c".repeat(65) }, 12],
    [{ appId: APP_ID, certificate: CERT, channel: "c", account: "a".repeat(256) }, 13],
    [{ appId: APP_ID, certificate: CERT, channel: "c", tokenExpire: 0 }, 15]
  ];
  for (const [request, code] of cases) assert.throws(() => buildRtcToken(request), (error) => error instanceof TokenError && error.code === code && !error.message.includes(secret) && !error.message.includes("not-an-app-id"), String(code));
  assert.throws(() => buildRtmToken({ appId: APP_ID, certificate: CERT, userId: "u".repeat(65) }), { code: 14 });
  assert.throws(() => buildRtcToken({ appId: APP_ID, certificate: CERT, channel: "a\0b" }), { message: "Token fields cannot contain a NUL character." });
  assert.throws(() => buildRtcToken({ appId: APP_ID, certificate: CERT, channel: "c", uid: -1 }), TokenError);
  assert.throws(() => decodeToken("007!!"), { code: 21 });
  // The module keeps working after failures.
  assert.ok(buildRtmToken({ appId: APP_ID, certificate: CERT, userId: "after" }).startsWith("007"));
});
