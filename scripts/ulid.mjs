// A ULID (https://github.com/ulid/spec): 48 bits of milliseconds, then 80 random bits, in Crockford base32 (26 characters),
// made as Auth makes them (Auth's src/ulid.mjs). The Portal's own IDs use it lower-cased: rl-… releases, pa-… admin actions.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(time = Date.now(), random = randomBytes(10)) {
  if (!Number.isSafeInteger(time) || time < 0 || time > 2 ** 48 - 1) throw new RangeError("ULID time must fit in 48 bits.");
  if (random.length !== 10) throw new RangeError("ULID randomness must be 10 bytes.");
  let timePart = "";
  let rest = time;
  for (let index = 0; index < 10; index += 1) {
    timePart = ALPHABET[rest % 32] + timePart;
    rest = Math.floor(rest / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) {
    randomPart = ALPHABET[Number(bits & 31n)] + randomPart;
    bits >>= 5n;
  }
  return timePart + randomPart;
}
