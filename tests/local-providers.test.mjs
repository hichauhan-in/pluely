import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadTs(relative, imports = {}) {
  const filename = path.join(root, relative);
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = compiled.require.bind(compiled);
  compiled.require = (name) => Object.hasOwn(imports, name) ? imports[name] : originalRequire(name);
  const result = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  compiled._compile(result.outputText, filename.replace(/\.ts$/, ".test.cjs"));
  return compiled.exports;
}

const transport = loadTs("src/lib/local-provider-transport.ts");
const constants = loadTs("src/config/local-providers.constants.ts");
const wav = loadTs("src/lib/utils.ts");
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const answer = (text) => json({ choices: [{ message: { content: text } }] });

async function collect(iterable) {
  let result = "";
  for await (const chunk of iterable) result += chunk;
  return result;
}

function streamResponse(text, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

const connected = () => ({
  connection: { base_url: "http://127.0.0.1:9876", token: "a".repeat(64) },
  status: {
    source: "Pluely", ready: true, message: "Ready",
    supports_images: true, supports_cancellation: true, default_model: "vision-id",
    models: [{ id: "vision-id", name: "Vision", family: "vision", supports_images: true }],
  },
});
const request = (extra = {}) => ({
  model: "vision-id", systemPrompt: "Be concise.", history: [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
  ], userMessage: "Next question", imagesBase64: [], ...extra,
});

function copilot(invoke, fetch) {
  return loadTs("src/lib/functions/copilot-bridge.function.ts", {
    "@tauri-apps/api/core": { invoke },
    "@tauri-apps/plugin-http": { fetch },
    "../local-provider-transport": transport,
  });
}

test("local endpoints reject remote hosts, redirects, credentials and non-root paths", () => {
  assert.equal(transport.localServerUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(transport.localServerUrl("http://[::1]:8080"), "http://[::1]:8080");
  for (const value of [
    "https://127.0.0.1:8080", "http://example.com:8080", "file:///tmp/test",
    "http://127.0.0.1", "http://user:password@127.0.0.1:8080",
    "http://127.0.0.1:8080/path", "http://127.0.0.1:8080?next=remote",
  ]) assert.throws(() => transport.localServerUrl(value));
});

test("SSE decoding handles split UTF-8, CRLF, control frames and a final DONE without newline", async () => {
  const events = [
    ": keepalive", "", 'data: {"choices":[{"delta":{"role":"assistant"}}]}', "",
    'data: {"choices":[{"delta":{"content":"Hello \\u4e16\\u754c"}}]}', "",
    "data: [DONE]",
  ].join("\r\n").replace("\\u4e16\\u754c", "\u4e16\u754c");
  assert.equal(await collect(transport.readBridgeResponse(streamResponse(events))), "Hello \u4e16\u754c");
});

test("legacy nonstream responses work; failures cannot masquerade as assistant text", async () => {
  assert.equal(await collect(transport.readBridgeResponse(answer("legacy answer"))), "legacy answer");
  await assert.rejects(collect(transport.readBridgeResponse(json({ error: "Not authorized" }, 403))), /Not authorized/);
  await assert.rejects(collect(transport.readBridgeResponse(answer(""))), /empty response/);
  await assert.rejects(collect(transport.readBridgeResponse(json({ unexpected: true }))), /invalid chat/);
});

test("truncated streams, malformed JSON and mid-stream errors are surfaced", async () => {
  const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  await assert.rejects(collect(transport.readBridgeResponse(streamResponse(partial))), /disconnected/);
  await assert.rejects(collect(transport.readBridgeResponse(streamResponse("data: not-json\n\n"))), SyntaxError);
  await assert.rejects(collect(transport.readBridgeResponse(streamResponse(
    partial + 'data: {"error":{"message":"Copilot quota exceeded"}}\n\n'
  ))), /quota exceeded/);
});

test("DONE leaves the native HTTP channel open until it delivers its final EOF", async () => {
  let sink;
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { sink = controller; },
    cancel() { cancelled = true; },
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  sink.enqueue(new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n'
  ));
  assert.equal(await collect(transport.readBridgeResponse(response)), "done");
  assert.equal(cancelled, false);
  assert.doesNotThrow(() => sink.close());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.locked, false);
});

test("image data retains its MIME type and unsupported attachments fail explicitly", () => {
  assert.equal(transport.imageDataUrl("/9j/test"), "data:image/jpeg;base64,/9j/test");
  assert.equal(transport.imageDataUrl("iVBORw0KGgoTEST"), "data:image/png;base64,iVBORw0KGgoTEST");
  assert.equal(transport.imageDataUrl("data:image/webp;base64,UklGRtest"), "data:image/webp;base64,UklGRtest");
  assert.throws(() => transport.imageDataUrl("unsupported"), /PNG, JPEG/);
});

test("Copilot discovers a fresh session before every request and preserves context and selected model", async () => {
  const calls = [];
  let session = 0;
  const client = copilot(async (command) => {
    calls.push(command);
    const current = connected();
    current.connection.token = (++session).toString().repeat(64);
    return current;
  }, async (url, options) => {
    calls.push("request");
    assert.equal(url, "http://127.0.0.1:9876/v1/chat/completions");
    assert.equal(options.maxRedirections, 0);
    assert.equal(options.headers.Authorization, `Bearer ${session.toString().repeat(64)}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "vision-id");
    assert.equal(body.stream, true);
    assert.match(body.request_id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(body.messages.slice(0, 3), [
      { role: "system", content: "Be concise." }, ...request().history,
    ]);
    assert.equal(body.messages[3].content[1].image_url.url, "data:image/png;base64,iVBORw0KGgoTEST");
    return answer("ready");
  });
  const params = request({ imagesBase64: ["iVBORw0KGgoTEST"] });
  assert.equal(await collect(client.fetchCopilotResponse(params)), "ready");
  assert.equal(await collect(client.fetchCopilotResponse(params)), "ready");
  assert.deepEqual(calls, ["connect_copilot_bridge", "request", "connect_copilot_bridge", "request"]);
  assert.equal(params.history.length, 2);
});

test("missing bridge, unavailable image capability and pre-aborted requests never send a prompt", async () => {
  let sends = 0;
  const fetch = async () => { sends++; return answer("wrong"); };
  const unavailable = copilot(async () => { throw new Error("Bridge setup required"); }, fetch);
  await assert.rejects(collect(unavailable.fetchCopilotResponse(request())), /setup required/);
  const textOnly = copilot(async () => {
    const value = connected();
    value.status.supports_images = false;
    return value;
  }, fetch);
  await assert.rejects(collect(textOnly.fetchCopilotResponse(request({ imagesBase64: ["iVBORw0KGgoTEST"] }))), /cannot accept images/);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await collect(unavailable.fetchCopilotResponse(request({ signal: controller.signal }))), "");
  assert.equal(sends, 0);
});

test("legacy bridges request nonstreaming replies so native HTTP cancellation remains effective", async () => {
  const client = copilot(async () => {
    const value = connected();
    value.status.supports_cancellation = false;
    return value;
  }, async (url, options) => {
    assert.ok(url.endsWith("/v1/chat/completions"));
    assert.equal(JSON.parse(options.body).stream, false);
    return answer("legacy");
  });
  assert.equal(await collect(client.fetchCopilotResponse(request())), "legacy");
});

test("stopping a streamed response explicitly cancels the matching background task", async () => {
  const controller = new AbortController();
  let activeId;
  let cancellationId;
  let transportSignal;
  let streamController;
  const client = copilot(async () => connected(), async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/cancel")) {
      cancellationId = body.request_id;
      streamController.close();
      return json({ cancelled: true });
    }
    activeId = body.request_id;
    transportSignal = options.signal;
    return new Response(new ReadableStream({
      start(stream) {
        streamController = stream;
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const iterator = client.fetchCopilotResponse(request({ signal: controller.signal }));
  assert.equal((await iterator.next()).value, "first");
  controller.abort();
  assert.equal((await iterator.next()).done, true);
  assert.equal(activeId, cancellationId);
  assert.equal(transportSignal.aborted, false);
});

function whisper(fetch) {
  return loadTs("src/lib/functions/local-whisper.function.ts", {
    "@tauri-apps/plugin-http": { fetch },
    "@/config/local-providers.constants": constants,
    "../local-provider-transport": transport,
    "../utils": wav,
  });
}

test("local Whisper preflights health then normalizes stereo audio to 16 kHz mono WAV", async () => {
  const original = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    constructor(channels, length, rate) {
      assert.deepEqual([channels, length, rate], [1, 1, 16000]);
    }
    async decodeAudioData() {
      return {
        length: 2, numberOfChannels: 2,
        getChannelData: (channel) => channel ? new Float32Array([0.5, -0.5]) : new Float32Array([0.5, -0.5]),
      };
    }
  };
  try {
    const paths = [];
    const client = whisper(async (url, options) => {
      paths.push(url);
      if (url.endsWith("/health")) return json({ status: "ok" });
      assert.equal(options.maxRedirections, 0);
      assert.equal(options.body.get("language"), "hi");
      assert.equal(options.body.get("response_format"), "json");
      const audio = new DataView(await options.body.get("file").arrayBuffer());
      assert.equal(audio.getUint16(22, true), 1);
      assert.equal(audio.getUint32(24, true), 16000);
      assert.equal(audio.getUint16(34, true), 16);
      assert.equal(audio.getInt16(44, true), 16383);
      assert.equal(audio.getInt16(46, true), -16384);
      return json({ text: " local transcript " });
    });
    assert.equal(await client.transcribeLocalWhisper(new Blob(["fake webm"], { type: "audio/webm" }), { language: "hi" }), "local transcript");
    assert.deepEqual(paths, ["http://127.0.0.1:8080/health", "http://127.0.0.1:8080/inference"]);
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = original;
  }
});

test("Whisper loading, missing service and remote URLs fail before audio is uploaded", async () => {
  let calls = 0;
  const client = whisper(async (url) => {
    calls++;
    assert.ok(url.endsWith("/health"));
    return json({ status: "loading model" }, 503);
  });
  await assert.rejects(client.transcribeLocalWhisper(new Blob(["audio"]), {}), /Whisper is not ready/);
  await assert.rejects(client.transcribeLocalWhisper(new Blob(["audio"]), { base_url: "http://remote.example:8080" }), /local server/);
  assert.equal(calls, 1);
});

test("key-free speech is dispatched before hosted API selection", async () => {
  let transcribed = false;
  const stt = loadTs("src/lib/functions/stt.function.ts", {
    "./common.function": {},
    "@tauri-apps/plugin-http": {},
    "@tauri-apps/api/core": {},
    "@bany/curl-to-json": () => { throw new Error("Should not parse cURL"); },
    "./pluely.api": { shouldUsePluelyAPI: () => { throw new Error("Should not use hosted STT"); } },
    "@/config/local-providers.constants": constants,
    "./local-whisper.function": { transcribeLocalWhisper: async () => { transcribed = true; return "local"; } },
  });
  assert.equal(await stt.fetchSTT({
    selectedProvider: { provider: constants.LOCAL_WHISPER_PROVIDER_ID, variables: {} },
    audio: new Blob(["audio"]),
  }), "local");
  assert.ok(transcribed);
});

test("Copilot dispatch takes priority over hosted AI without parsing an API-key template", async () => {
  let received;
  const ai = loadTs("src/lib/functions/ai-response.function.ts", {
    "./common.function": {},
    "@tauri-apps/plugin-http": {},
    "@tauri-apps/api/core": {},
    "@tauri-apps/api/event": {},
    "@bany/curl-to-json": () => { throw new Error("Should not parse cURL"); },
    "./pluely.api": { shouldUsePluelyAPI: () => { throw new Error("Should not use hosted AI"); } },
    "../chat-constants": {},
    "@/lib": { getResponseSettings: () => ({}), RESPONSE_LENGTHS: [], LANGUAGES: [] },
    "@/config/constants": { MARKDOWN_FORMATTING_INSTRUCTIONS: "Use Markdown." },
    "@/config/local-providers.constants": constants,
    "./copilot-bridge.function": { fetchCopilotResponse: async function* (params) { received = params; yield "Copilot"; } },
  });
  assert.equal(await collect(ai.fetchAIResponse({
    selectedProvider: { provider: constants.COPILOT_PROVIDER_ID, variables: { model: "chosen-model" } },
    systemPrompt: "Context", userMessage: "Question",
  })), "Copilot");
  assert.equal(received.model, "chosen-model");
  assert.match(received.systemPrompt, /Context.*Use Markdown/);
});

test("voice setup establishes Copilot before Whisper and does not probe ordinary API providers", async () => {
  const calls = [];
  const setup = loadTs("src/lib/functions/local-provider-setup.function.ts", {
    "@tauri-apps/api/core": { invoke: async (command) => { calls.push(command); } },
    "@/config/local-providers.constants": constants,
    "./local-whisper.function": { checkLocalWhisper: async () => { calls.push("whisper"); } },
  });
  await setup.checkLocalProviderSetup(
    { provider: constants.COPILOT_PROVIDER_ID },
    { provider: constants.LOCAL_WHISPER_PROVIDER_ID, variables: {} }
  );
  assert.deepEqual(calls, ["connect_copilot_bridge", "whisper"]);
  await setup.checkLocalProviderSetup({ provider: "openai" }, { provider: "groq", variables: {} });
  assert.equal(calls.length, 2);
});

test("existing API-key AI and STT providers retain their HTTP request paths", async () => {
  const common = loadTs("src/lib/functions/common.function.ts");
  const shared = {
    "./common.function": common,
    "@tauri-apps/plugin-http": {},
    "@tauri-apps/api/core": {},
    "./pluely.api": { shouldUsePluelyAPI: async () => false },
    "@/config/local-providers.constants": constants,
  };
  const ai = loadTs("src/lib/functions/ai-response.function.ts", {
    ...shared,
    "@tauri-apps/api/event": {},
    "@bany/curl-to-json": () => ({
      url: "https://provider.example/chat", method: "POST",
      header: { Authorization: "Bearer {{API_KEY}}" },
      data: { messages: [{ role: "user", content: "{{TEXT}}" }] },
    }),
    "../chat-constants": {},
    "@/lib": { getResponseSettings: () => ({}), RESPONSE_LENGTHS: [], LANGUAGES: [] },
    "@/config/constants": { MARKDOWN_FORMATTING_INSTRUCTIONS: "Use Markdown." },
    "./copilot-bridge.function": { fetchCopilotResponse: () => { throw new Error("Unexpected bridge"); } },
  });
  const stt = loadTs("src/lib/functions/stt.function.ts", {
    ...shared,
    "@bany/curl-to-json": () => ({
      url: "https://provider.example/transcribe", method: "POST",
      header: { Authorization: "Bearer {{API_KEY}}" },
      form: { 0: "file={{AUDIO}}", 1: "model=whisper" },
    }),
    "./local-whisper.function": { transcribeLocalWhisper: () => { throw new Error("Unexpected local Whisper"); } },
  });
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url, options) => {
    paths.push(url);
    assert.equal(options.headers.Authorization, "Bearer test-key");
    if (url.endsWith("/chat")) {
      assert.equal(JSON.parse(options.body).messages[0].content, "Question");
      return answer("API answer");
    }
    assert.equal(options.body.get("model"), "whisper");
    return json({ text: "API transcript" });
  };
  try {
    const selectedProvider = { provider: "existing-api", variables: { api_key: "test-key" } };
    assert.equal(await collect(ai.fetchAIResponse({
      provider: { curl: "curl {{API_KEY}}", streaming: false, responseContentPath: "choices[0].message.content" },
      selectedProvider, userMessage: "Question",
    })), "API answer");
    assert.equal(await stt.fetchSTT({
      provider: { curl: "curl -F file={{AUDIO}}", responseContentPath: "text" },
      selectedProvider, audio: new Blob(["audio"]),
    }), "API transcript");
    assert.deepEqual(paths, ["https://provider.example/chat", "https://provider.example/transcribe"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
