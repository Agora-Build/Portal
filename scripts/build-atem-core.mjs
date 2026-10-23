// Rebuilds scripts/vendor/atem-core.wasm from native/atem-core-wasm (Atem's atem-core-ffi at the pinned revision) and
// records its checksum, Atem revision and compilers in scripts/vendor/atem-core.json. Needs Rust with the
// wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`) and clang with LLVM's ar for zlib's C
// source (CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown, else the first clang and llvm-ar found). The server
// and Docker image use the committed module, so neither needs Rust. Upgrade the Atem revision together with
// Astation's Config/atem-core.json, and check tests/fixtures/astation-token-compatibility.json still matches.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const crate = new URL("native/atem-core-wasm/", root);
const manifest = await readFile(new URL("Cargo.toml", crate), "utf8");
const revision = manifest.match(/Agora-Build\/Atem\.git", rev = "([0-9a-f]{40})"/)?.[1];
if (!revision) throw new Error("native/atem-core-wasm/Cargo.toml must pin atem-core-ffi to a full Atem revision.");
const found = (names) => names.find((name) => { try { execFileSync(name, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });
const versions = [19, 18, 17, 16].map(String);
const cc = process.env.CC_wasm32_unknown_unknown || found([...versions.map((v) => "clang-" + v), "clang"]);
const ar = process.env.AR_wasm32_unknown_unknown || found([...versions.map((v) => "llvm-ar-" + v), "llvm-ar"]);
if (!cc || !ar) throw new Error("Install clang and llvm-ar (or set CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown) to compile zlib.");
execFileSync("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown"], { cwd: crate, stdio: "inherit", env: { ...process.env, CC_wasm32_unknown_unknown: cc, AR_wasm32_unknown_unknown: ar } });
const output = new URL("scripts/vendor/atem-core.wasm", root);
await copyFile(new URL("target/wasm32-unknown-unknown/release/portal_atem_core.wasm", crate), output);
const sha256 = createHash("sha256").update(await readFile(output)).digest("hex");
const rustc = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
const clang = execFileSync(cc, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
await writeFile(new URL("scripts/vendor/atem-core.json", root), JSON.stringify({ atemRevision: revision, abiVersion: 1, sha256, rustc, cc: clang, compression: "zlib (as Astation)", target: "wasm32-unknown-unknown" }, null, 2) + "\n");
console.log("scripts/vendor/atem-core.wasm " + sha256 + " (Atem " + revision.slice(0, 12) + ", " + rustc + ")");
