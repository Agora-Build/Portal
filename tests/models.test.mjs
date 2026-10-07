import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createModelClient, modelConfig } from "../scripts/models.mjs";
const people = JSON.parse(await readFile(new URL("../data/people.json", import.meta.url), "utf8"));
const config = modelConfig({ OPENAI_API_KEY: "test-only-model-key" });
const completion = (content) => Response.json({ choices: [{ message: { content } }] });

test("providers require explicit configuration; local compatible inference can work without a key", () => {
  assert.equal(modelConfig({}).language.ready, false);
  assert.equal(modelConfig({}).speech.ready, false);
  assert.equal(modelConfig({}).radar.ready, false);
  const local = modelConfig({ LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "local-model" });
  assert.equal(local.language.ready, true);
  assert.equal(local.language.model, "local-model");
  assert.equal(local.radar.ready, false);
  assert.equal(modelConfig({ OSS_API_KEY: "not-an-inference-key" }).language.ready, false);
  assert.equal(modelConfig({ OPENAI_API_KEY: "test-only" }).radar.ready, true);
});
test("model-ranked search sends real facts and accepts only known eligible identities", async () => {
  let calls = 0;
  const client = createModelClient(config, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.strict, true);
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.profiles[0].intent, "");
    assert.equal(input.profiles[0].location, "Santa Clara, CA");
    assert.equal(input.profiles[0].projects.length, 16);
    return completion(JSON.stringify({ matches: [
      { id: "made-up-builder", reason: "Invented person" },
      { id: "github:guohai", reason: "Contributes to RTC-Egress and voice evaluation tools." },
      { id: "github:guohai", reason: "Duplicate" }
    ] }));
  });
  const result = await client.search(people, "Someone building real-time tools", "Rust");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "github:guohai");
  assert.match(result[0].matchReason, /RTC-Egress/);
  assert.deepEqual(await client.search(people, "Someone", "Pottery"), []);
  assert.equal(calls, 1);
});
test("malformed model results and upstream errors stay understandable without leaking secrets", async () => {
  const bad = createModelClient(config, async () => completion("not-json"));
  await assert.rejects(bad.search(people, "Rust"), { status: 502 });
  const failed = createModelClient(config, async () => new Response("upstream-secret-details", { status: 401 }));
  await assert.rejects(failed.chat("Help"), (error) => error.status === 502 && !error.message.includes("upstream-secret-details"));
  const unavailable = createModelClient(config, async () => { throw new Error("test-only-model-key"); });
  await assert.rejects(unavailable.chat("Help"), (error) => error.status === 502 && !error.message.includes("test-only-model-key"));
});
test("speech validates voices and sends only configured speech settings", async () => {
  const client = createModelClient(config, async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/audio/speech");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-4o-mini-tts");
    assert.equal(body.input, "Hello builders");
    assert.equal(body.voice, "coral");
    assert.equal(body.response_format, "mp3");
    return new Response("ID3-test-audio");
  });
  await assert.rejects(client.speak("Hello", "unavailable"), { status: 422 });
  assert.equal((await client.speak("Hello builders", "coral")).toString(), "ID3-test-audio");
  const empty = createModelClient(config, async () => new Response(""));
  await assert.rejects(empty.speak("Hello", "coral"), { status: 502 });
});
test("radar publishes only URLs retrieved or cited by web search", async () => {
  const client = createModelClient(config, async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.tools[0].type, "web_search");
    assert.equal(body.tool_choice, "required");
    assert.ok(body.include.includes("web_search_call.action.sources"));
    assert.equal(body.text.format.strict, true);
    const input = JSON.parse(body.input[1].content);
    assert.equal(input.intent, "Build a voice agent");
    assert.equal(input.contact, undefined);
    return Response.json({ output: [
      { type: "web_search_call", action: { sources: [{ url: "https://example.com/retrieved" }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: [
        { kind: "person", title: "Public engineer", url: "https://example.com/retrieved", reason: "Works on interruption handling" },
        { kind: "resource", title: "Cited resource", url: "https://example.com/cited", reason: "Explains latency" },
        { kind: "person", title: "Invented", url: "https://example.com/not-seen", reason: "Should be rejected" },
        { kind: "resource", title: "Unsafe", url: "javascript:alert(1)", reason: "Should be rejected" },
        { kind: "person", title: "Duplicate", url: "https://example.com/retrieved", reason: "Duplicate" }
      ] }), annotations: [{ type: "url_citation", url: "https://example.com/cited" }] }] }
    ] });
  });
  const result = await client.research({ ...people[0], intent: "Build a voice agent" });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.url), ["https://example.com/retrieved", "https://example.com/cited"]);
});
