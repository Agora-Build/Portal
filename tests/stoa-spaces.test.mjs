import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSpace, inviteUrl, memberPath, spacePayload } from "../stoa/spaces.js";

test("form values become a valid space request", () => {
  assert.deepEqual(spacePayload({ title: "  Lab  ", purpose: " Pairing ", visibility: "private", access: "open", capacity: "8", themeId: "cyberpunk" }), { title: "Lab", purpose: "Pairing", visibility: "private", access: "members", capacity: 8, themeId: "cyberpunk" });
  assert.deepEqual(spacePayload({ title: "Lab", visibility: "listed", access: "house", capacity: "12" }), { title: "Lab", purpose: "", visibility: "unlisted", access: "house", capacity: 12, themeId: "agora" });
  assert.equal(spacePayload({ title: "Lab", access: "everyone", capacity: "x" }).access, "members");
  assert.ok(Number.isNaN(spacePayload({ title: "Lab", capacity: "x" }).capacity), "the server reports a bad capacity");
});
test("spaces are described in plain words, and invite links are absolute", () => {
  assert.equal(describeSpace({ visibility: "private", access: "members", occupancy: 2 }), "Private · members only · 2 here");
  assert.equal(describeSpace({ visibility: "unlisted", access: "open", occupancy: 0 }), "Unlisted · anyone with the link · 0 here");
  assert.equal(inviteUrl("https://agora.build", "/stoa/s/abc?invite=xyz"), "https://agora.build/stoa/s/abc?invite=xyz");
});
test("member ids keep their colon in the path, which the server matches literally", () => {
  assert.equal(memberPath("account:0b1c2d3e-0000-4000-8000-000000000000"), "account:0b1c2d3e-0000-4000-8000-000000000000");
  assert.equal(memberPath("a/b"), "a%2Fb");
});
