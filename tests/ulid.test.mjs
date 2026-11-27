import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "../scripts/ulid.mjs";

test("a ULID is 26 Crockford base32 characters, the time first, so later ones sort after earlier ones", () => {
  assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(ulid(0, Buffer.alloc(10)), "0".repeat(26));
  assert.equal(ulid(2 ** 48 - 1, Buffer.alloc(10, 255)), "7" + "Z".repeat(25));
  assert.equal(ulid(1469918176385, Buffer.alloc(10)).slice(0, 10), "01ARYZ6S41", "the ULID spec's example time");
  assert.ok(ulid(1000) < ulid(1001));
  assert.throws(() => ulid(-1), RangeError);
  assert.throws(() => ulid(2 ** 48), RangeError);
  assert.throws(() => ulid(0, Buffer.alloc(9)), RangeError);
});
