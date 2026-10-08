import { test } from "node:test";
import assert from "node:assert/strict";
import tokenTypes from "agora-token/src/AccessToken2.js";
import { agoraConfig, createAgoraCalls } from "../scripts/calls.mjs";

const config = agoraConfig({ AGORA_APP_ID: "a".repeat(32), AGORA_APP_CERTIFICATE: "b".repeat(32), AGORA_TOKEN_TTL_SECONDS: "600" });
const person = { id: "member:72a639ba-3a45-4afe-936b-111111111111" };
const room = { id: "fd616fdb-aa48-4c67-bd26-222222222222" };

test("Agora configuration requires certificate authentication and bounds the lifetime of both media privileges", () => {
  assert.equal(agoraConfig({}).ready, false);
  assert.equal(agoraConfig({ AGORA_APP_ID: config.appId }).ready, false);
  assert.equal(agoraConfig({ AGORA_APP_ID: "invalid", AGORA_APP_CERTIFICATE: config.certificate }).ready, false);
  assert.equal(config.ready, true);
  assert.equal(agoraConfig({ AGORA_TOKEN_TTL_SECONDS: "-10" }).ttl, 60);
  assert.equal(agoraConfig({ AGORA_TOKEN_TTL_SECONDS: "86400" }).ttl, 3600);
  assert.equal(agoraConfig({ AGORA_TOKEN_TTL_SECONDS: "invalid" }).ttl, 3600);
});
test("camera and screen tokens have valid signatures, exact channels and identities, and expiring publisher privileges", () => {
  const calls = createAgoraCalls(config, { now: () => 1700000000000 });
  const credentials = calls.issueSpace(room, person);
  assert.equal(credentials.expiresAt, new Date(1700000000000 + 600000).toISOString());
  for (const [value, uid] of [[credentials.token, credentials.uid], [credentials.screenToken, credentials.screenUid]]) {
    const parsed = new tokenTypes.AccessToken2();
    assert.equal(parsed.from_string(value), true);
    assert.equal(parsed.verifySignature(config.certificate), true);
    assert.equal(parsed.verifySignature("c".repeat(32)), false);
    assert.equal(parsed.appId.toString(), config.appId);
    assert.equal(parsed.expire, 600);
    assert.equal(parsed.services.length, 1);
    const rtc = parsed.services[0];
    assert.equal(rtc.__channel_name.toString(), "agora-build-space-" + room.id);
    assert.equal(rtc.__uid.toString(), uid);
    assert.deepEqual(rtc.__privileges, { 1: 600, 2: 600, 3: 600, 4: 600 });
  }
});
test("renewals reject other identities, screen identities, and malformed identifiers; separate tabs do not collide", () => {
  const calls = createAgoraCalls(config);
  const first = calls.issueSpace(room, person);
  assert.notEqual(calls.issueSpace(room, person).uid, first.uid);
  assert.equal(calls.issueSpace(room, person, { uid: first.uid }).uid, first.uid);
  for (const uid of [null, 12, {}, "another-member_123456789abc", first.uid + "extra", first.screenUid]) assert.throws(() => calls.issueSpace(room, person, { uid }), { status: 422 });
});
test("space calls use the space channel and an identity derived from the account", () => {
  const calls = createAgoraCalls(config);
  const actor = { id: "account:72a639ba-3a45-4afe-936b-333333333333" };
  const credentials = calls.issueSpace({ id: "lot-ai-agents" }, actor);
  assert.equal(credentials.channel, "agora-build-space-lot-ai-agents");
  assert.match(credentials.uid, /^72a639ba-3a45-4afe-936b-333333333333_[a-f0-9]{12}$/);
  assert.equal(credentials.screenUid, credentials.uid + "_screen");
  assert.equal(calls.issueSpace({ id: "lot-ai-agents" }, actor, { uid: credentials.uid }).uid, credentials.uid);
  assert.throws(() => calls.issueSpace({ id: "lot-ai-agents" }, actor, { uid: "someone_123456789abc" }), { status: 422 });
  assert.throws(() => createAgoraCalls(agoraConfig({})).issueSpace({ id: "lot-ai-agents" }, actor), { status: 503 });
});
