"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const http = require("node:http");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "extension.js");
const source = readFileSync(entry, "utf8");
const nativeRequire = createRequire(entry);
const manifest = nativeRequire("./package.json");
const clone = (value) => JSON.parse(JSON.stringify(value));
let nextPid = process.pid * 100;

function reply(...fragments) {
  return { text: (async function* () { yield* fragments; })() };
}

function makeModel({ id = "copilot-public-id", family = "chat-family", name = "Copilot Model", send } = {}) {
  const model = {
    id, family, name, vendor: "copilot", version: "1", maxInputTokens: 100_000, calls: [],
    async sendRequest(messages, options, token) {
      model.calls.push({ messages, options, token });
      return send ? send(messages, options, token) : reply("Hello", " world");
    },
  };
  return model;
}

function makeVscode(options) {
  const state = {
    models: options.models ?? [makeModel()],
    consent: Object.hasOwn(options, "consent") ? options.consent : true,
    commands: new Map(), outputs: [], logs: [], errors: [], information: [], progress: [],
    sources: [], selections: [], accessListeners: new Set(), uriHandlers: new Set(), images: [],
  };
  class CancellationTokenSource {
    constructor(kind = "model") {
      this.kind = kind;
      this.cancelCount = 0;
      this.disposeCount = 0;
      this.listeners = new Set();
      this.cancelled = false;
      const owner = this;
      this.token = {
        get isCancellationRequested() { return owner.cancelled; },
        onCancellationRequested(callback) {
          owner.listeners.add(callback);
          return { dispose: () => owner.listeners.delete(callback) };
        },
      };
      state.sources.push(this);
    }
    cancel() {
      this.cancelCount++;
      if (this.cancelled) return;
      this.cancelled = true;
      for (const listener of this.listeners) listener();
    }
    dispose() {
      this.disposeCount++;
      this.listeners.clear();
    }
  }
  class LanguageModelTextPart {
    constructor(value) { this.value = value; }
  }
  class LanguageModelDataPart {
    constructor(data, mimeType) { this.data = Uint8Array.from(data); this.mimeType = mimeType; }
    static image(data, mimeType) {
      const part = new LanguageModelDataPart(data, mimeType);
      state.images.push(part);
      return part;
    }
  }
  const vscode = {
    CancellationTokenSource,
    LanguageModelTextPart,
    LanguageModelDataPart: options.imageApi === false ? undefined : LanguageModelDataPart,
    LanguageModelChatMessage: {
      User: (content) => ({ role: "user", content }),
      Assistant: (content) => ({ role: "assistant", content }),
    },
    ProgressLocation: { Notification: 15 },
    lm: {
      async selectChatModels(selector) {
        state.selections.push(clone(selector));
        return options.select ? options.select(selector) : state.models;
      },
    },
    commands: {
      registerCommand(name, callback) {
        assert.equal(state.commands.has(name), false, "commands must not be registered twice");
        state.commands.set(name, callback);
        return { dispose: () => state.commands.delete(name) };
      },
      executeCommand() { assert.fail("The bridge must never execute chat UI or tool commands"); },
    },
    window: {
      createOutputChannel(name) {
        const output = {
          name, showCount: 0, disposeCount: 0,
          appendLine(line) { state.logs.push(line); },
          show() { output.showCount++; },
          dispose() { output.disposeCount++; },
        };
        state.outputs.push(output);
        return output;
      },
      registerUriHandler(handler) {
        state.uriHandlers.add(handler);
        return { dispose: () => state.uriHandlers.delete(handler) };
      },
      showInformationMessage(message) { state.information.push(message); return Promise.resolve(); },
      showErrorMessage(message) { state.errors.push(message); return Promise.resolve(); },
      async withProgress(config, action) {
        const cancellation = new CancellationTokenSource("progress");
        state.progress.push({ config, cancellation });
        try {
          return await action({ report() {} }, cancellation.token);
        } finally {
          cancellation.listenersAtFinish = cancellation.listeners.size;
          cancellation.dispose();
        }
      },
    },
  };
  const context = { subscriptions: [] };
  if (options.accessApi !== false) {
    context.languageModelAccessInformation = {
      canSendRequest: (model) => typeof state.consent === "function" ? state.consent(model) : state.consent,
      onDidChange(callback) {
        state.accessListeners.add(callback);
        return { dispose: () => state.accessListeners.delete(callback) };
      },
    };
  }
  return { vscode, context, state };
}

async function newHome() {
  // Scratch homes stay inside this extension's test directory, never in the OS temp directory.
  return fs.mkdtemp(path.join(__dirname, ".bridge-home-"));
}

async function harness(t, options = {}) {
  const home = options.home || await newHome();
  const pid = ++nextPid;
  const { vscode, context, state } = makeVscode(options);
  const servers = [];
  const wrappedFs = {
    ...fs,
    async open(file, ...args) {
      if (options.beforeOpen) await options.beforeOpen(file);
      return fs.open(file, ...args);
    },
    async rename(from, to) {
      if (options.beforeRename) await options.beforeRename(from, to);
      return fs.rename(from, to);
    },
    async unlink(file) {
      if (options.beforeUnlink) await options.beforeUnlink(file);
      return fs.unlink(file);
    },
  };
  const module = { exports: {} };
  const sandbox = vm.createContext({
    module, Buffer, AbortController,
    process: { pid, platform: process.platform },
    setTimeout: (callback, milliseconds, ...args) => setTimeout(callback,
      milliseconds === 180_000 ? options.timeoutMs ?? milliseconds : milliseconds, ...args),
    clearTimeout,
    console: { error: (message) => state.logs.push(message) },
    require(name) {
      if (name === "vscode") return vscode;
      if (name === "node:os") return { ...os, homedir: () => home };
      if (name === "node:fs/promises") return wrappedFs;
      if (name === "node:http") return {
        ...http,
        createServer(...args) {
          const server = http.createServer(...args);
          servers.push(server);
          return server;
        },
      };
      return nativeRequire(name);
    },
  });
  vm.runInContext(source, sandbox, { filename: entry });
  const extension = module.exports;
  const handshakePath = path.join(home, ".pluely", "bridges", `${pid}.json`);
  const instance = {
    home, pid, state, context, extension, servers, handshakePath, sandbox,
    handshake: async () => JSON.parse(await fs.readFile(handshakePath, "utf8")),
    async request(options = {}) { return request(await instance.handshake(), options); },
    async chat(payload = {}, options = {}) {
      return instance.request({
        method: "POST",
        route: "/v1/chat/completions",
        payload: { messages: [{ role: "user", content: "Hello" }], ...payload },
        ...options,
      });
    },
    async cancel(requestId, options = {}) {
      return instance.request({
        method: "POST", route: "/v1/chat/cancel", payload: { request_id: requestId }, ...options,
      });
    },
    command(name) { return state.commands.get(`pluelyCopilot.${name}`)(); },
  };
  t.after(async () => {
    try {
      await extension.deactivate();
    } finally {
      if (!options.home) await fs.rm(home, { recursive: true, force: true });
    }
    assert.equal(servers.every((server) => !server.listening), true, "all HTTP servers must close");
  });
  if (options.activate !== false) await extension.activate(context);
  return instance;
}

function request(handshake, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.raw ?? (options.payload === undefined ? undefined : JSON.stringify(options.payload));
    const headers = {
      ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? handshake.token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    };
    if (body !== undefined && !Object.hasOwn(headers, "content-length") && !headers["transfer-encoding"]) {
      headers["content-length"] = Buffer.byteLength(body);
    }
    const outgoing = http.request(new URL(options.route || "/health", handshake.base_url), {
      method: options.method || "GET", headers, agent: false,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => {
        chunks.push(chunk);
        options.onChunk?.(chunk);
      });
      incoming.once("error", reject);
      incoming.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          if (incoming.headers["content-type"]?.startsWith("application/json")) json = JSON.parse(text);
        } catch (error) {
          reject(error);
          return;
        }
        resolve({ status: incoming.statusCode, headers: incoming.headers, text, json });
      });
    });
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("Test HTTP request timed out")));
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for bridge state");
}

function frames(text) {
  return text.trim().split("\n\n").map((frame) => {
    assert.equal(frame.startsWith("data: "), true);
    const data = frame.slice(6);
    return data === "[DONE]" ? data : JSON.parse(data);
  });
}

function assertQuiet(state) {
  assert.equal(state.outputs.some((output) => output.showCount > 0), false);
  assert.deepEqual(state.progress, []);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.information, []);
}

function assertDisposed(state) {
  for (const source of state.sources) {
    assert.equal(source.disposeCount, 1);
    assert.equal(source.listeners.size, 0);
    if (source.kind === "progress") assert.equal(source.listenersAtFinish, 0);
  }
}

test("manifest is portable, dependency-free, local, and embeds only two production files", () => {
  assert.equal(manifest.name, "pluely-copilot-bridge");
  assert.equal(manifest.publisher, "pluely");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.license, "GPL-3.0");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "commonjs");
  assert.equal(manifest.main, "extension.js");
  assert.deepEqual(manifest.extensionKind, ["ui"]);
  assert.deepEqual(manifest.activationEvents, ["onStartupFinished", "onUri"]);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.enabledApiProposals, undefined);
  assert.deepEqual(manifest.contributes.commands.map((command) => command.command), [
    "pluelyCopilot.authorize", "pluelyCopilot.status", "pluelyCopilot.restart",
  ]);
  assert.equal(manifest.contributes.commands[0].title, "Pluely: Authorize Copilot Access");
  const localRequires = [...source.matchAll(/require\(["'](\.[^"']+)["']\)/g)].map((match) => match[1]);
  assert.deepEqual(localRequires, ["./package.json"]);
});

test("activation atomically publishes a private per-host handshake and is idempotent", async (t) => {
  let renames = 0;
  const bridge = await harness(t, {
    async beforeRename(from, to) {
      renames++;
      assert.equal(path.dirname(from), path.dirname(to));
      assert.equal(path.extname(from), ".tmp");
      const staged = JSON.parse(await fs.readFile(from, "utf8"));
      assert.match(staged.token, /^[a-f0-9]{64}$/);
      assert.equal(staged.bridge_version, "0.1.0");
      await assert.rejects(fs.access(to), { code: "ENOENT" });
      if (process.platform !== "win32") {
        assert.equal((await fs.stat(from)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(path.dirname(from))).mode & 0o777, 0o700);
      }
    },
  });
  const handshake = await bridge.handshake();
  assert.deepEqual(Object.keys(handshake).sort(), ["base_url", "bridge_version", "pid", "token"]);
  assert.match(handshake.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(handshake.pid, bridge.pid);
  assert.equal(bridge.servers[0].address().address, "127.0.0.1");
  assert.equal(Number(new URL(handshake.base_url).port) > 0, true);
  await Promise.all([bridge.extension.activate(bridge.context), bridge.extension.activate(bridge.context)]);
  assert.equal(renames, 1);
  assert.equal(bridge.servers.length, 1);
  assert.equal(bridge.state.commands.size, 3);
  assert.equal(bridge.state.uriHandlers.size, 1);
  assert.equal(bridge.state.outputs.length, 1);
  assert.deepEqual(await fs.readdir(path.dirname(bridge.handshakePath)), [`${bridge.pid}.json`]);
  assert.equal(bridge.state.logs.join("\n").includes(handshake.token), false);
  assertQuiet(bridge.state);
});

test("multiple extension hosts coexist and stopping one does not remove another handshake", async (t) => {
  const home = await newHome();
  const first = await harness(t, { home });
  const second = await harness(t, { home });
  t.after(async () => {
    await first.extension.deactivate();
    await second.extension.deactivate();
    await fs.rm(home, { recursive: true, force: true });
  });
  const a = await first.handshake();
  const b = await second.handshake();
  assert.notEqual(a.pid, b.pid);
  assert.notEqual(a.base_url, b.base_url);
  assert.notEqual(a.token, b.token);
  await first.extension.deactivate();
  await assert.rejects(fs.access(first.handshakePath), { code: "ENOENT" });
  assert.deepEqual(await second.handshake(), b);
  assert.equal((await second.request()).status, 200);
});

test("shutdown verifies handshake token ownership instead of deleting a replacement file", async (t) => {
  const bridge = await harness(t);
  const replacement = { ...(await bridge.handshake()), token: "a".repeat(64) };
  const neighbor = path.join(path.dirname(bridge.handshakePath), "unrelated.json");
  await fs.writeFile(bridge.handshakePath, JSON.stringify(replacement));
  await fs.writeFile(neighbor, '{"neighbor":true}');
  await bridge.extension.deactivate();
  assert.deepEqual(await bridge.handshake(), replacement);
  assert.equal(await fs.readFile(neighbor, "utf8"), '{"neighbor":true}');
  assert.match(bridge.state.logs.join("\n"), /ownership changed/);
});

test("restart rotates authentication and deactivation/activation cleanly disposes resources", async (t) => {
  const bridge = await harness(t);
  const initial = await bridge.handshake();
  assert.equal(await bridge.command("restart"), true);
  const restarted = await bridge.handshake();
  assert.notEqual(restarted.token, initial.token);
  assert.equal(bridge.servers[0].listening, false);
  assert.equal((await bridge.request({ token: initial.token })).status, 401);
  assert.equal((await bridge.request()).status, 200);
  await Promise.all([bridge.extension.deactivate(), bridge.extension.deactivate()]);
  assert.equal(bridge.state.commands.size, 0);
  assert.equal(bridge.state.uriHandlers.size, 0);
  assert.equal(bridge.state.accessListeners.size, 0);
  assert.equal(bridge.state.outputs[0].disposeCount, 1);
  await assert.rejects(fs.access(bridge.handshakePath), { code: "ENOENT" });
  await bridge.extension.activate(bridge.context);
  assert.equal((await bridge.request()).status, 200);
  assert.notEqual((await bridge.handshake()).token, restarted.token);
  assertDisposed(bridge.state);
});

test("startup failure closes the server, removes only its staging file, and releases registrations", async (t) => {
  const bridge = await harness(t, {
    activate: false,
    beforeRename() { throw Object.assign(new Error("Sensitive path not logged"), { code: "EACCES" }); },
  });
  await assert.rejects(bridge.extension.activate(bridge.context), { code: "bridge_start_failed" });
  assert.equal(bridge.servers[0].listening, false);
  assert.deepEqual(await fs.readdir(path.dirname(bridge.handshakePath)), []);
  assert.equal(bridge.state.commands.size, 0);
  assert.equal(bridge.state.outputs[0].disposeCount, 1);
  assert.match(bridge.state.logs.join("\n"), /EACCES/);
  assert.doesNotMatch(bridge.state.logs.join("\n"), /Sensitive path/);
});

test("a staging-file collision never deletes a file this instance did not create", async (t) => {
  let collision;
  const bridge = await harness(t, {
    activate: false,
    async beforeOpen(file) {
      collision = file;
      await fs.writeFile(file, "not owned by this bridge");
    },
  });
  await assert.rejects(bridge.extension.activate(bridge.context), { code: "bridge_start_failed" });
  assert.equal(await fs.readFile(collision, "utf8"), "not owned by this bridge");
  assert.equal(bridge.servers[0].listening, false);
});

test("health reports live model IDs, metadata, and unknown consent without sending a prompt", async (t) => {
  const model = makeModel({ id: "opaque-copilot-id", family: "friendly-family", name: "Friendly Name" });
  const bridge = await harness(t, { models: [model], consent: undefined });
  const response = await bridge.request();
  assert.deepEqual(response.json, {
    ok: true, copilot_available: true, consented: null,
    models: ["opaque-copilot-id"],
    model_details: [{ id: "opaque-copilot-id", family: "friendly-family", name: "Friendly Name", supports_images: false }],
    default_model: "opaque-copilot-id", bridge_version: "0.1.0",
    capabilities: { images: false, streaming: true, cancellation: true },
  });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(bridge.state.selections, [{ vendor: "copilot" }]);
  bridge.state.models = [makeModel({ id: "new-live-id" })];
  bridge.state.consent = true;
  assert.deepEqual((await bridge.request()).json.models, ["new-live-id"]);
  assert.equal((await bridge.request()).json.consented, true);
  assertQuiet(bridge.state);
  assertDisposed(bridge.state);
});

test("empty and utility-only catalogues are honestly unavailable and never auto-selected", async (t) => {
  const utility = makeModel({ id: "copilot-utility-small" });
  const internal = makeModel({ id: "copilot-internal/planner" });
  const bridge = await harness(t, { models: [utility, internal] });
  let health = (await bridge.request()).json;
  assert.equal(health.copilot_available, false);
  assert.equal(health.consented, null);
  assert.deepEqual(health.models, []);
  assert.equal(health.default_model, "");
  assert.equal((await bridge.chat()).json.error.code, "copilot_unavailable");
  assert.equal(utility.calls.length, 0);
  assert.equal(internal.calls.length, 0);
  const publicModel = makeModel();
  bridge.state.models.push(publicModel);
  assert.equal((await bridge.chat()).status, 200);
  assert.equal(publicModel.calls.length, 1);
  bridge.state.models = [];
  health = (await bridge.request()).json;
  assert.equal(health.copilot_available, false);
});

test("catalogue failures remain errors rather than masquerading as an empty successful health response", async (t) => {
  const bridge = await harness(t, { select() { throw new Error("private provider failure"); } });
  const response = await bridge.request();
  assert.equal(response.status, 502);
  assert.equal(response.json.error.code, "copilot_request_failed");
  assert.doesNotMatch(response.text + bridge.state.logs.join(""), /private provider/);
});

test("exact model IDs win over colliding families and names", async (t) => {
  const collision = makeModel({ id: "other-id", family: "wanted-id", name: "wanted-id" });
  const exact = makeModel({ id: "wanted-id", family: "actual-family", name: "Actual Name" });
  const bridge = await harness(t, { models: [collision, exact] });
  const response = await bridge.chat({ model: "wanted-id" });
  assert.equal(response.status, 200);
  assert.equal(response.json.model, "wanted-id");
  assert.equal(collision.calls.length, 0);
  assert.equal(exact.calls.length, 1);
  assert.equal((await bridge.chat({ model: "actual-family" })).json.model, "wanted-id");
  assert.equal((await bridge.chat({ model: "Actual Name" })).json.model, "wanted-id");
});

test("an explicit unavailable model is never silently replaced", async (t) => {
  const model = makeModel();
  const bridge = await harness(t, { models: [model] });
  const response = await bridge.chat({ model: "retired-model" });
  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, "model_not_available");
  assert.equal(model.calls.length, 0);
  bridge.state.models = [];
  assert.equal((await bridge.chat({ model: "retired-model" })).json.error.code, "model_not_available");
});

test("nonstream completion preserves system instructions, chronological history, and whitespace", async (t) => {
  const model = makeModel();
  const bridge = await harness(t, { models: [model] });
  const response = await bridge.chat({
    messages: [
      { role: "system", content: "Instructions\n" },
      { role: "user", content: "First request" },
      { role: "assistant", content: "First response" },
      { role: "system", content: "Later instructions" },
      { role: "user", content: [{ type: "text", text: "  Current " }, { type: "text", text: "request\n" }] },
    ],
    tools: [{ type: "function", function: { name: "run_terminal" } }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.choices[0].message.content, "Hello world");
  assert.equal(response.json.choices[0].message.role, "assistant");
  assert.deepEqual(clone(model.calls[0].messages), [
    { role: "user", content: "Instructions\n" },
    { role: "user", content: "First request" },
    { role: "assistant", content: "First response" },
    { role: "user", content: "Later instructions" },
    { role: "user", content: "  Current request\n" },
  ]);
  assert.deepEqual(clone(model.calls[0].options), {});
  assert.equal(model.calls[0].token.isCancellationRequested, false);
  assertQuiet(bridge.state);
  assertDisposed(bridge.state);
});

test("streaming sends ordered OpenAI-shaped text deltas and DONE only after success", async (t) => {
  const bridge = await harness(t);
  const response = await bridge.chat({ stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^text\/event-stream/);
  const events = frames(response.text);
  assert.deepEqual(events.slice(0, -1).map((event) => event.choices[0].delta.content), ["Hello", " world"]);
  assert.equal(events.at(-1), "[DONE]");
  assertQuiet(bridge.state);
  assertDisposed(bridge.state);
});

test("explicit cancellation ends a connected stream with an error and no DONE", async (t) => {
  let returned = 0;
  const model = makeModel({
    send() {
      let first = true;
      return { text: {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (first) { first = false; return Promise.resolve({ value: "partial", done: false }); }
          return new Promise(() => {});
        },
        return() { returned++; return Promise.resolve({ done: true }); },
      } };
    },
  });
  const bridge = await harness(t, { models: [model] });
  const requestId = randomUUID();
  let received = false;
  const pending = bridge.chat({ request_id: requestId, stream: true }, {
    onChunk() { received = true; },
  });
  await waitFor(() => received);
  const response = await bridge.cancel(requestId.toUpperCase());
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { cancelled: true });
  const completion = await pending;
  assert.equal(completion.status, 200);
  const events = frames(completion.text);
  assert.equal(events[0].choices[0].delta.content, "partial");
  assert.equal(events[1].error.code, "request_cancelled");
  assert.doesNotMatch(completion.text, /\[DONE\]/);
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  assert.equal(returned, 1);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: false });
  assertQuiet(bridge.state);
  assertDisposed(bridge.state);
});

test("duplicate active UUIDs are rejected without removing the original cancellation mapping", async (t) => {
  let pendingModel = true;
  const model = makeModel({ send: () => pendingModel ? new Promise(() => {}) : reply("Complete") });
  const bridge = await harness(t, { models: [model] });
  const requestId = randomUUID();
  const pending = bridge.chat({ request_id: requestId });
  await waitFor(() => model.calls.length === 1);
  const duplicate = await bridge.chat({ request_id: requestId.toUpperCase() });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, "duplicate_request_id");
  assert.equal(model.calls.length, 1);
  assert.equal((await bridge.cancel(requestId, { token: null })).status, 401);
  assert.equal((await bridge.cancel(requestId, { headers: { origin: "" } })).status, 403);
  assert.equal(model.calls[0].token.isCancellationRequested, false);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: true });
  const cancelled = await pending;
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.json.error.code, "request_cancelled");
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  pendingModel = false;
  const reused = await bridge.chat({ request_id: requestId });
  assert.equal(reused.status, 200);
  assert.equal(reused.json.choices[0].message.content, "Complete");
  assert.equal(model.calls.length, 2);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: false });
  assertDisposed(bridge.state);
});

test("request cancellation validates UUIDs and returns false for unknown or finished requests", async (t) => {
  const bridge = await harness(t);
  assert.equal((await bridge.request()).json.capabilities.cancellation, true);
  for (const requestId of [null, "", "not-a-uuid", 42, [], {}, "a".repeat(36), `${randomUUID()}suffix`]) {
    for (const response of [await bridge.chat({ request_id: requestId }), await bridge.cancel(requestId)]) {
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, "invalid_request_id");
    }
  }
  const missing = await bridge.cancel(undefined);
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, "invalid_request_id");
  assert.equal((await bridge.cancel(undefined, { raw: "{" })).json.error.code, "invalid_json");
  assert.equal((await bridge.cancel(undefined, { payload: [] })).json.error.code, "invalid_request");
  assert.deepEqual((await bridge.cancel(randomUUID())).json, { cancelled: false });
  assert.equal(bridge.state.models[0].calls.length, 0);
  const requestId = randomUUID();
  assert.equal((await bridge.chat({ request_id: requestId })).status, 200);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: false });
  assertQuiet(bridge.state);
  assertDisposed(bridge.state);
});

test("failed requests release their UUID cancellation mappings", async (t) => {
  const bridge = await harness(t, {
    models: [makeModel({ send() { throw new Error("Failed request"); } })],
  });
  const requestId = randomUUID();
  assert.equal((await bridge.chat({ request_id: requestId })).status, 502);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: false });
  assert.equal((await bridge.chat({ request_id: requestId })).status, 502, "the finished UUID can be reused");
  assertDisposed(bridge.state);
});

test("send failures are non-2xx JSON, remember denied access, and do not disclose provider errors", async (t) => {
  const model = makeModel({
    send() { throw Object.assign(new Error("secret token and prompt"), { code: "NoPermissions" }); },
  });
  const bridge = await harness(t, { models: [model], consent: undefined });
  bridge.state.consent = true;
  const response = await bridge.chat({ stream: true });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, "copilot_consent_required");
  assert.doesNotMatch(response.text, /secret token and prompt/);
  assert.equal((await bridge.request()).json.consented, true, "health reports explicit access information");
  assert.equal((await bridge.chat()).status, 403, "generation must not silently retry failed authorization");
  assert.equal(model.calls.length, 1);
  bridge.state.consent = undefined;
  assert.equal((await bridge.request()).json.consented, null);
  bridge.state.consent = false;
  assert.equal((await bridge.request()).json.consented, false, "only explicit access denial reports false");
  assert.doesNotMatch(bridge.state.logs.join("\n"), /secret token and prompt/);
  assertDisposed(bridge.state);
});

test("failure before the first stream fragment is JSON, while mid-stream failure is SSE without DONE", async (t) => {
  let early = true;
  const model = makeModel({
    send() {
      return { text: (async function* () {
        if (!early) yield "partial";
        throw new Error("private prompt content");
      })() };
    },
  });
  const bridge = await harness(t, { models: [model] });
  const first = await bridge.chat({ stream: true });
  assert.equal(first.status, 502);
  assert.equal(first.json.error.code, "copilot_request_failed");
  early = false;
  const second = await bridge.chat({ stream: true });
  assert.equal(second.status, 200);
  const events = frames(second.text);
  assert.equal(events[0].choices[0].delta.content, "partial");
  assert.equal(events[1].error.code, "copilot_request_failed");
  assert.doesNotMatch(second.text, /\[DONE\]|private prompt content/);
  assertQuiet(bridge.state);
  assertDisposed(bridge.state);
});

test("authorization, browser headers including empty headers, and non-loopback Host are rejected", async (t) => {
  const bridge = await harness(t);
  for (const options of [
    { token: null },
    { token: "wrong" },
    { token: "é".repeat(64) },
  ]) {
    const response = await bridge.request(options);
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "unauthorized");
  }
  for (const headers of [
    { origin: "https://example.invalid" }, { origin: "" },
    { "sec-fetch-site": "none" }, { "sec-fetch-site": "" },
  ]) {
    const response = await bridge.request({ headers });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "browser_request_denied");
  }
  for (const host of ["example.invalid", "127.0.0.1:1", "127.0.0.1.example.invalid"]) {
    assert.equal((await bridge.request({ headers: { host } })).json.error.code, "invalid_host");
  }
  assert.equal(bridge.state.selections.length, 0);
  assertQuiet(bridge.state);
});

test("malformed JSON, invalid payloads, and declared oversized requests have explicit errors", async (t) => {
  const bridge = await harness(t);
  assert.equal((await bridge.chat({}, { raw: "{" })).json.error.code, "invalid_json");
  assert.equal((await bridge.chat({}, { raw: Buffer.from([0xff]) })).json.error.code, "invalid_json");
  for (const payload of [
    null, [], {},
    { messages: [] },
    { messages: [{ role: "tool", content: "do something" }] },
    { messages: [{ role: "user", content: [{ type: "audio", data: "no" }] }] },
    { messages: [{ role: "user", content: null }] },
    { model: 1, messages: [{ role: "user", content: "x" }] },
    { stream: "true", messages: [{ role: "user", content: "x" }] },
  ]) {
    const result = await bridge.request({ method: "POST", route: "/v1/chat/completions", payload });
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "invalid_request");
  }
  const oversized = await bridge.chat({}, { raw: "{}", headers: { "content-length": 8 * 1024 * 1024 + 1 } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, "request_too_large");
  assert.equal(bridge.state.models[0].calls.length, 0);
});

test("chunked oversized bodies get a readable 413 instead of losing the error to socket destruction", async (t) => {
  const bridge = await harness(t);
  const response = await bridge.chat({}, {
    raw: Buffer.alloc(8 * 1024 * 1024 + 1, " "),
    headers: { "transfer-encoding": "chunked" },
  });
  assert.equal(response.status, 413);
  assert.equal(response.json.error.code, "request_too_large");
  assertDisposed(bridge.state);
});

const images = [
  ["image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString("base64")],
  ["image/webp", Buffer.from("524946460c000000574542505650382000000000", "hex").toString("base64")],
  ["image/gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
];
const imageMessage = (url) => ({
  messages: [{
    role: "user",
    content: [{ type: "text", text: "Describe this" }, { type: "image_url", image_url: { url } }],
  }],
});

test("supported public image parts preserve bytes, but unverified model vision never gets guessed or sent", async (t) => {
  const model = makeModel({ id: "vision-looking-name" });
  Object.defineProperty(model, "capabilities", {
    get() { assert.fail("Proposed model capability APIs must not be accessed"); },
  });
  const bridge = await harness(t, { models: [model] });
  for (const [mime, base64] of images) {
    const response = await bridge.chat(imageMessage(`data:${mime};base64,${base64}`));
    assert.equal(response.status, 501);
    assert.equal(response.json.error.code, "image_capabilities_unavailable");
    const part = bridge.state.images.at(-1);
    assert.equal(part.mimeType, mime);
    assert.equal(Buffer.from(part.data).toString("base64"), base64);
  }
  assert.equal(model.calls.length, 0, "images must never be silently stripped from an actual request");
  const health = (await bridge.request()).json;
  assert.equal(health.capabilities.images, false);
  assert.equal(health.model_details[0].supports_images, false);
});

test("missing public image APIs and malformed or remote images fail explicitly", async (t) => {
  const bridge = await harness(t, { imageApi: false });
  const [mime, base64] = images[0];
  const missing = await bridge.chat(imageMessage(`data:${mime};base64,${base64}`));
  assert.equal(missing.status, 501);
  assert.equal(missing.json.error.code, "image_api_unavailable");
  for (const url of [
    "https://example.invalid/image.png",
    "file:///private.png",
    "data:image/png;base64,@@@@",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,YWJjZA==",
    "data:image/png;base64,YR==",
    `data:image/jpeg;base64,${base64}`,
  ]) {
    const response = await bridge.chat(imageMessage(url));
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "invalid_image");
  }
  assert.equal(bridge.state.models[0].calls.length, 0);
});

test("unknown consent is not promoted by discovery or by a denied HTTP request", async (t) => {
  const bridge = await harness(t, { consent: undefined });
  assert.equal((await bridge.request()).json.consented, null);
  const denied = await bridge.chat();
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "copilot_consent_required");
  assert.equal((await bridge.request()).json.consented, null);
  assert.equal(bridge.state.models[0].calls.length, 0);
  assertQuiet(bridge.state);
});

test("health reports true for any permitted eligible model and false only for explicit access denial", async (t) => {
  const first = makeModel({ id: "first-model" });
  const second = makeModel({ id: "second-model" });
  const utility = makeModel({ id: "copilot-utility-small" });
  const permission = new Map([[utility.id, true]]);
  const bridge = await harness(t, {
    models: [first, second, utility],
    consent: (model) => permission.get(model.id),
  });
  assert.equal((await bridge.request()).json.consented, null, "utility model access does not establish readiness");
  permission.set(first.id, false);
  assert.equal((await bridge.request()).json.consented, false);
  permission.set(second.id, true);
  assert.equal((await bridge.request()).json.consented, true);
  permission.delete(first.id);
  permission.delete(second.id);
  assert.equal((await bridge.request()).json.consented, null);
  assert.equal(first.calls.length + second.calls.length + utility.calls.length, 0);
  assertQuiet(bridge.state);
});

test("restarts preserve unknown or successful session consent without inventing denial", async (t) => {
  for (const options of [{ consent: undefined }, { accessApi: false }]) {
    const bridge = await harness(t, options);
    assert.equal((await bridge.request()).json.consented, null);
    assert.equal(await bridge.command("restart"), true);
    assert.equal((await bridge.request()).json.consented, null);
    assert.equal(await bridge.command("authorize"), true);
    assert.equal((await bridge.request()).json.consented, true);
    assert.equal(await bridge.command("restart"), true);
    assert.equal((await bridge.request()).json.consented, true);
    assert.equal((await bridge.chat()).status, 200);
    await bridge.extension.deactivate();
    await bridge.extension.activate(bridge.context);
    assert.equal((await bridge.request()).json.consented, null, "a fresh session with unknown access is not denied");
    assertDisposed(bridge.state);
  }
});

test("guided authorization consumes the tiny response, deduplicates prompts, and disposes cancellation", async (t) => {
  let finished = 0;
  const model = makeModel({
    send() {
      return { text: (async function* () {
        yield "rea";
        yield "dy";
        finished++;
      })() };
    },
  });
  const bridge = await harness(t, { models: [model], consent: undefined });
  const first = bridge.command("authorize");
  const second = bridge.command("authorize");
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(finished, 1);
  assert.equal(model.calls.length, 1);
  assert.deepEqual(clone(model.calls[0].messages), [{ role: "user", content: "Reply only with ready." }]);
  assert.match(model.calls[0].options.justification, /Pluely/);
  assert.equal(bridge.state.progress.length, 1);
  assert.equal(bridge.state.information.length, 1);
  assert.equal((await bridge.request()).json.consented, true);
  assert.equal((await bridge.chat()).status, 200);
  assertDisposed(bridge.state);
  bridge.state.consent = false;
  for (const listener of bridge.state.accessListeners) listener();
  assert.equal((await bridge.request()).json.consented, false);
  assert.equal((await bridge.chat()).status, 403);
});

test("failed authorization reports failure without treating partial text or unknown access as consent", async (t) => {
  const model = makeModel({
    send() {
      return { text: (async function* () {
        yield "rea";
        throw Object.assign(new Error("Private credential text"), { code: "NoPermissions" });
      })() };
    },
  });
  const bridge = await harness(t, { models: [model], consent: undefined });
  assert.equal(await bridge.command("authorize"), false);
  assert.equal((await bridge.request()).json.consented, null);
  bridge.state.consent = false;
  assert.equal((await bridge.request()).json.consented, false);
  assert.equal(bridge.state.information.length, 0);
  assert.match(bridge.state.errors[0], /not authorized/);
  assert.doesNotMatch(bridge.state.logs.join("\n") + bridge.state.errors.join("\n"), /Private credential/);
  assertDisposed(bridge.state);
});

test("the setup URI invokes authorization and status opens only its own log on a user action", async (t) => {
  const bridge = await harness(t, { consent: undefined });
  const [handler] = bridge.state.uriHandlers;
  await handler.handleUri({ authority: "pluely.pluely-copilot-bridge", path: "/not-setup" });
  assert.equal(bridge.state.models[0].calls.length, 0);
  await handler.handleUri({ authority: "pluely.pluely-copilot-bridge", path: "/setup" });
  assert.equal(bridge.state.models[0].calls.length, 1);
  const health = await bridge.command("status");
  assert.equal(health.consented, true);
  assert.equal(bridge.state.outputs[0].showCount, 1);
  assertDisposed(bridge.state);
});

test("ordinary request body close does not cancel an in-flight model response", async (t) => {
  const model = makeModel({
    async send(_messages, _options, token) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(token.isCancellationRequested, false);
      return reply("Complete");
    },
  });
  const bridge = await harness(t, { models: [model] });
  const response = await bridge.chat();
  assert.equal(response.status, 200);
  assert.equal(response.json.choices[0].message.content, "Complete");
  assert.equal(model.calls[0].token.isCancellationRequested, false);
  assert.equal(bridge.state.sources.every((source) => source.cancelCount === 0), true);
  assertDisposed(bridge.state);
});

test("disconnecting an incomplete request body releases the operation without calling a model", async (t) => {
  const bridge = await harness(t);
  const handshake = await bridge.handshake();
  const outgoing = http.request(`${handshake.base_url}/v1/chat/completions`, {
    method: "POST", agent: false,
    headers: {
      authorization: `Bearer ${handshake.token}`,
      "content-type": "application/json",
      "content-length": 1000,
    },
  });
  outgoing.on("error", () => {});
  outgoing.write('{"messages":[');
  await waitFor(() => bridge.state.sources.length === 1);
  outgoing.destroy();
  await waitFor(() => bridge.state.sources[0].disposeCount === 1);
  assert.equal(bridge.state.models[0].calls.length, 0);
  assertDisposed(bridge.state);
});

test("a client disconnect before response headers cancels a pending model request", async (t) => {
  const model = makeModel({ send: () => new Promise(() => {}) });
  const bridge = await harness(t, { models: [model] });
  const handshake = await bridge.handshake();
  const outgoing = http.request(`${handshake.base_url}/v1/chat/completions`, {
    method: "POST", agent: false,
    headers: { authorization: `Bearer ${handshake.token}`, "content-type": "application/json" },
  });
  outgoing.on("error", () => {});
  outgoing.end(JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }));
  await waitFor(() => model.calls.length === 1);
  outgoing.destroy();
  await waitFor(() => bridge.state.sources[0].disposeCount === 1);
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  assertDisposed(bridge.state);
});

test("disconnecting a streaming response cancels the model and releases its cancellation source", async (t) => {
  let returned = 0;
  const model = makeModel({
    send() {
      let first = true;
      return { text: {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (first) { first = false; return Promise.resolve({ value: "first", done: false }); }
          return new Promise(() => {});
        },
        return() { returned++; return Promise.resolve({ done: true }); },
      } };
    },
  });
  const bridge = await harness(t, { models: [model] });
  const requestId = randomUUID();
  const handshake = await bridge.handshake();
  await new Promise((resolve, reject) => {
    const outgoing = http.request(`${handshake.base_url}/v1/chat/completions`, {
      method: "POST", agent: false,
      headers: { authorization: `Bearer ${handshake.token}`, "content-type": "application/json" },
    }, (incoming) => {
      incoming.once("data", () => { incoming.destroy(); resolve(); });
      incoming.on("error", () => {});
    });
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify({
      messages: [{ role: "user", content: "Hello" }], stream: true, request_id: requestId,
    }));
  });
  await waitFor(() => bridge.state.sources[0]?.disposeCount === 1);
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  assert.equal(returned, 1);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: false });
  assertDisposed(bridge.state);
});

test("timeout cancels even a provider that ignores cancellation and returns a clear nonstream error", async (t) => {
  const model = makeModel({ send: () => new Promise(() => {}) });
  const bridge = await harness(t, { models: [model], timeoutMs: 60 });
  const requestId = randomUUID();
  const response = await bridge.chat({ request_id: requestId });
  assert.equal(response.status, 504);
  assert.equal(response.json.error.code, "request_timeout");
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: false });
  assertDisposed(bridge.state);
});

test("timeout after a stream fragment emits an error frame without DONE", async (t) => {
  const model = makeModel({
    send() {
      let count = 0;
      return { text: {
        [Symbol.asyncIterator]() { return this; },
        next() { return ++count === 1 ? Promise.resolve({ value: "first", done: false }) : new Promise(() => {}); },
        return() { return Promise.resolve({ done: true }); },
      } };
    },
  });
  const bridge = await harness(t, { models: [model], timeoutMs: 60 });
  const response = await bridge.chat({ stream: true });
  const events = frames(response.text);
  assert.equal(events[0].choices[0].delta.content, "first");
  assert.equal(events[1].error.code, "request_timeout");
  assert.doesNotMatch(response.text, /\[DONE\]/);
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  assertDisposed(bridge.state);
});

test("restart cancels in-flight generation, closes connections, and publishes a fresh working bridge", async (t) => {
  const model = makeModel({ send: () => new Promise(() => {}) });
  const bridge = await harness(t, { models: [model] });
  const initial = await bridge.handshake();
  const requestId = randomUUID();
  const pending = bridge.chat({ request_id: requestId }).then((result) => ({ result }), (error) => ({ error }));
  await waitFor(() => model.calls.length === 1);
  const activeIds = vm.runInContext("activeBridge.run.requestsById", bridge.sandbox);
  assert.equal(activeIds.size, 1);
  assert.equal(await bridge.command("restart"), true);
  await pending;
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  assert.equal(bridge.servers[0].listening, false);
  const count = await new Promise((resolve, reject) => bridge.servers[0].getConnections((error, value) =>
    error ? reject(error) : resolve(value)));
  assert.equal(count, 0);
  assert.equal(activeIds.size, 0);
  assert.notEqual((await bridge.handshake()).token, initial.token);
  assert.equal((await bridge.request()).status, 200);
  assert.deepEqual((await bridge.cancel(requestId)).json, { cancelled: false });
  assertDisposed(bridge.state);
});

test("cancelling guided authorization disposes the UI token listener and the model source", async (t) => {
  const model = makeModel({ send: () => new Promise(() => {}) });
  const bridge = await harness(t, { models: [model], consent: undefined });
  const pending = bridge.command("authorize");
  await waitFor(() => model.calls.length === 1);
  bridge.state.progress[0].cancellation.cancel();
  assert.equal(await pending, false);
  assert.equal(model.calls[0].token.isCancellationRequested, true);
  assert.equal((await bridge.request()).json.consented, null);
  assertDisposed(bridge.state);
});

test("cleanup failures are logged and reported without exposing tokens", async (t) => {
  let refuse = false;
  const bridge = await harness(t, {
    beforeUnlink(file) {
      if (refuse && file.endsWith(".json")) {
        throw Object.assign(new Error("Do not log token or path"), { code: "EACCES" });
      }
    },
  });
  const handshake = await bridge.handshake();
  refuse = true;
  await assert.rejects(bridge.extension.deactivate(), { code: "bridge_cleanup_failed" });
  assert.equal(bridge.servers[0].listening, false);
  assert.equal(bridge.state.commands.size, 0);
  assert.equal(bridge.state.outputs[0].disposeCount, 1);
  assert.match(bridge.state.logs.join("\n"), /Handshake cleanup failed \(EACCES\)/);
  assert.doesNotMatch(bridge.state.logs.join("\n"), /Do not log token/);
  assert.equal(bridge.state.logs.join("\n").includes(handshake.token), false);
});
