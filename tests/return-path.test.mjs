import { test } from "node:test";
import assert from "node:assert/strict";
import { returnPath, withSignin } from "../scripts/return-path.mjs";

test("return paths stay on allowlisted same-site pages and drop a stale signin outcome", () => {
  for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "/auth/google", "/api/profile", "/\ninvalid", "/oauth/authorize?client_id=vox", undefined, "x".repeat(1501)]) assert.equal(returnPath(value), "/");
  assert.equal(returnPath("/meet/11111111-1111-1111-1111-111111111111?signin=failed"), "/meet/11111111-1111-1111-1111-111111111111");
  assert.equal(returnPath("/stoa/"), "/stoa/");
  assert.equal(returnPath("/stoa/room/ai-agents?x=1"), "/stoa/room/ai-agents?x=1");
  assert.equal(returnPath("/stoa/s/11111111-1111-1111-1111-111111111111?invite=abc&signin=failed"), "/stoa/s/11111111-1111-1111-1111-111111111111?invite=abc");
  assert.equal(returnPath("/meetings.html"), "/");
  assert.equal(returnPath("/stoa/s/not-a-uuid"), "/");
  for (const [old, clean] of [["/account.html?connected=agora", "/account/?connected=agora"], ["/account", "/account/"], ["/explore.html?q=voice#top", "/explore/?q=voice#top"], ["/index.html", "/"], ["/stoa.html", "/stoa/"], ["/marketplaces/", "/marketplaces/"], ["/radar/?x=1", "/radar/?x=1"]]) assert.equal(returnPath(old), clean, old);
  for (const value of ["/unknown/", "/unknown.html", "/services/", "/services", "/services.html", "/account/../scripts/serve.mjs", "/account//"]) assert.equal(returnPath(value), "/", value);
});

test("withSignin adds the outcome and keeps the query and fragment", () => {
  assert.equal(withSignin("/account/#credits", "success"), "/account/?signin=success#credits");
  assert.equal(withSignin("/stoa/room/ai-agents?x=1&signin=failed", "failed"), "/stoa/room/ai-agents?x=1&signin=failed");
  assert.equal(withSignin("https://evil.example", "unavailable"), "/?signin=unavailable");
});
