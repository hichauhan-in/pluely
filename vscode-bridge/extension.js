"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const vscode = require("vscode");
const manifest = require("./package.json");

const VERSION = manifest.version;
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const AUTHORIZE_COMMAND = "Pluely: Authorize Copilot Access";
const CLEANUP_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EEXIST", "EMFILE", "ENFILE",
  "EROFS", "EINVAL", "EADDRINUSE", "EADDRNOTAVAIL", "ECONNRESET", "EPIPE",
  "ERR_SERVER_NOT_RUNNING",
]);

class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicError(error) {
  if (error instanceof BridgeError) return error;
  switch (error?.code) {
    case "NoPermissions":
      return new BridgeError(403, "copilot_consent_required",
        `Copilot access was not authorized. Run "${AUTHORIZE_COMMAND}" in VS Code.`);
    case "NotFound":
      return new BridgeError(404, "model_not_available",
        "The requested Copilot model is unavailable. Refresh the model list or choose Auto.");
    case "Blocked":
      return new BridgeError(429, "copilot_blocked",
        "Copilot blocked this request. Check your subscription, quota, and organization policy in VS Code.");
    default:
      return new BridgeError(502, "copilot_request_failed",
        "The VS Code Copilot request failed. Check Copilot access and service availability, then retry.");
  }
}

function cleanupCode(error) {
  return CLEANUP_CODES.has(error?.code) ? error.code : "UNKNOWN";
}

function cancelledError() {
  return new BridgeError(499, "request_cancelled", "The request was cancelled.");
}

class Operation {
  constructor(run) {
    if (!run || run.closing) {
      throw new BridgeError(503, "bridge_stopping", "The Copilot bridge is stopping. Reconnect and retry.");
    }
    this.source = new vscode.CancellationTokenSource();
    this.controller = new AbortController();
    this.error = null;
    this.disposed = false;
    this.finished = new Promise((resolve) => { this.finish = resolve; });
    this.timer = setTimeout(() => {
      this.cancel(new BridgeError(504, "request_timeout",
        "The Copilot bridge request timed out after 180 seconds."));
    }, REQUEST_TIMEOUT_MS);
    this.timer.unref?.();
    this.run = run;
    run.operations.add(this);
  }

  cancel(error = cancelledError()) {
    if (this.error || this.disposed) return;
    this.error = error;
    this.controller.abort(error);
    this.source.cancel();
  }

  onCancel(callback) {
    if (this.error) {
      callback(this.error);
      return { dispose() {} };
    }
    const listener = () => callback(this.error);
    this.controller.signal.addEventListener("abort", listener, { once: true });
    return { dispose: () => this.controller.signal.removeEventListener("abort", listener) };
  }

  wait(work) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const subscription = this.onCancel(reject);
      let result;
      try {
        result = work();
      } catch (error) {
        subscription.dispose();
        reject(error);
        return;
      }
      Promise.resolve(result).then(
        (value) => {
          subscription.dispose();
          if (this.error) reject(this.error);
          else resolve(value);
        },
        (error) => {
          subscription.dispose();
          reject(this.error || error);
        },
      );
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    try {
      this.source.dispose();
    } finally {
      this.run.operations.delete(this);
      this.finish();
    }
  }
}

function sendJson(response, status, payload, close = false) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(close ? { connection: "close" } : {}),
  });
  response.end(body);
}

function sendFailure(response, error) {
  if (response.destroyed || response.writableEnded) return;
  const payload = { error: { message: error.message, code: error.code } };
  if (response.headersSent) {
    response.end(`data: ${JSON.stringify(payload)}\n\n`);
  } else {
    sendJson(response, error.status, payload, true);
  }
}

function authorized(request, token) {
  const header = request.headers.authorization;
  const supplied = Buffer.from(
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "",
    "utf8",
  );
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function checkRequest(request, run) {
  if (Object.hasOwn(request.headers, "origin") || Object.hasOwn(request.headers, "sec-fetch-site")) {
    throw new BridgeError(403, "browser_request_denied", "Browser-origin requests are not allowed.");
  }
  const host = request.headers.host?.toLowerCase();
  if (host !== `127.0.0.1:${run.port}` && host !== `localhost:${run.port}`) {
    throw new BridgeError(403, "invalid_host", "The Host header must identify this loopback bridge.");
  }
  if (!authorized(request, run.token)) {
    throw new BridgeError(401, "unauthorized", "A valid bridge bearer token is required.");
  }
  if (run.closing) {
    throw new BridgeError(503, "bridge_stopping", "The Copilot bridge is stopping. Reconnect and retry.");
  }
}

function readBody(request, operation) {
  const length = request.headers["content-length"];
  if (length !== undefined && Number(length) > MAX_BODY_BYTES) {
    request.resume();
    return Promise.reject(new BridgeError(413, "request_too_large", "The request exceeds the 8 MiB limit."));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let subscription;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      subscription?.dispose();
    };
    const fail = (error) => {
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new BridgeError(413, "request_too_large", "The request exceeds the 8 MiB limit."));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      cleanup();
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch {
        reject(new BridgeError(400, "invalid_json", "The request body must be valid UTF-8 JSON."));
      }
    };
    const onAborted = () => fail(cancelledError());
    const onError = () => fail(new BridgeError(400, "request_read_failed", "The request body could not be read."));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    subscription = operation.onCancel(fail);
  });
}

function invalidRequest(message) {
  return new BridgeError(400, "invalid_request", message);
}

function parseRequestId(value, required = false) {
  if (value === undefined && !required) return null;
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BridgeError(400, "invalid_request_id", "request_id must be a UUID string in 8-4-4-4-12 form.");
  }
  return value.toLowerCase();
}

function parseImage(url) {
  const match = typeof url === "string"
    && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match || match[2].length % 4 !== 0) {
    throw new BridgeError(400, "invalid_image",
      "Images must be base64 data URIs containing PNG, JPEG, WebP, or GIF data. Remote URLs are not fetched.");
  }
  const mime = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  const canonical = bytes.length > 0 && bytes.toString("base64") === match[2];
  const valid = {
    "image/png": bytes.length >= 33
      && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      && bytes.toString("ascii", 12, 16) === "IHDR",
    "image/jpeg": bytes.length >= 4
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9,
    "image/webp": bytes.length >= 20
      && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
    "image/gif": bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)),
  }[mime];
  if (!canonical || !valid) {
    throw new BridgeError(400, "invalid_image", "The image data does not match its declared format.");
  }
  return { mime, bytes };
}

function parsePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidRequest("The request must be a JSON object.");
  }
  const requestId = parseRequestId(payload.request_id);
  if (payload.model !== undefined && typeof payload.model !== "string") {
    throw invalidRequest("model must be a model ID, family, name, or an empty string for Auto.");
  }
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
    throw invalidRequest("stream must be a boolean.");
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw invalidRequest("At least one message is required.");
  }
  let images = false;
  const messages = payload.messages.map((message) => {
    if (!message || !["system", "user", "assistant"].includes(message.role)) {
      throw invalidRequest("Only system, user, and assistant message roles are supported.");
    }
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    if (!Array.isArray(message.content) || message.content.length === 0) {
      throw invalidRequest("Message content must be text or a nonempty array of text/image_url parts.");
    }
    const content = message.content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return { text: part.text };
      if (part?.type === "image_url") {
        images = true;
        return { image: parseImage(part.image_url?.url) };
      }
      throw invalidRequest("Only text and image_url content parts are supported.");
    });
    return { role: message.role, content };
  });
  return { model: payload.model || "", stream: payload.stream === true, messages, images, requestId };
}

function imageDataApiAvailable() {
  return typeof vscode.LanguageModelDataPart?.image === "function"
    && typeof vscode.LanguageModelTextPart === "function";
}

function supportsImages() {
  // https://code.visualstudio.com/api/references/vscode-api#LanguageModelChat
  // The public API exposes DataPart.image, but not capabilities on LanguageModelChat.
  // supportsImageToText is still proposed; imageInput belongs to provider information.
  // Do not enable a proposal, probe private getters, or guess vision support from model names.
  return false;
}

function toLmMessages(messages) {
  return messages.map((message) => {
    let content = message.content;
    if (Array.isArray(content)) {
      if (content.some((part) => part.image)) {
        if (!imageDataApiAvailable()) {
          throw new BridgeError(501, "image_api_unavailable",
            "This VS Code version does not expose the supported image data API. Images were not sent.");
        }
        content = content.map((part) => part.image
          ? vscode.LanguageModelDataPart.image(part.image.bytes, part.image.mime)
          : new vscode.LanguageModelTextPart(part.text));
      } else {
        content = content.map((part) => part.text).join("");
      }
    }
    // System instructions stay in their original chronological position as supported user turns.
    return message.role === "assistant"
      ? vscode.LanguageModelChatMessage.Assistant(content)
      : vscode.LanguageModelChatMessage.User(content);
  });
}

function userFacing(model) {
  return ![model.id, model.family, model.name].some((value) =>
    /(?:^|[/:._ -])(?:utility|internal)(?:$|[/:._ -])/i.test(value || ""));
}

function chooseModel(models, requested, images) {
  let model;
  if (requested) {
    model = models.find((candidate) => candidate.id === requested)
      || models.find((candidate) => candidate.family === requested)
      || models.find((candidate) => candidate.name === requested);
    if (!model) {
      throw new BridgeError(404, "model_not_available",
        "The requested Copilot model is unavailable. Refresh the model list or choose Auto.");
    }
  } else {
    model = models.find((candidate) => !images || supportsImages(candidate));
  }
  if (models.length === 0) {
    throw new BridgeError(503, "copilot_unavailable",
      "VS Code reports no user-facing Copilot models. Install GitHub Copilot and sign in in this VS Code window.");
  }
  if (images && (!model || !supportsImages(model))) {
    throw new BridgeError(501, "image_capabilities_unavailable",
      "The stable VS Code API does not expose this model's image capability. Images were not sent. Use text or an image-capable provider.");
  }
  return model;
}

function startSse(response) {
  if (!response.headersSent) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
    });
  }
}

async function writeSse(response, payload, operation) {
  if (operation.error) throw operation.error;
  if (response.destroyed || response.writableEnded) throw cancelledError();
  startSse(response);
  if (response.write(`data: ${JSON.stringify(payload)}\n\n`)) return;
  await new Promise((resolve, reject) => {
    let subscription;
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
      subscription?.dispose();
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(cancelledError()); };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
    subscription = operation.onCancel((error) => { cleanup(); reject(error); });
  });
}

class Bridge {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("Pluely Copilot Bridge");
    this.outputClosed = false;
    this.directory = path.join(os.homedir(), ".pluely", "bridges");
    this.handshake = path.join(this.directory, `${process.pid}.json`);
    this.run = null;
    this.knownConsent = new Map();
    this.registrations = [];
    this.lifecycle = Promise.resolve();
    this.disposed = false;
    this.disposePromise = null;
    this.authorization = null;
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    if (this.outputClosed) console.error(`Pluely Copilot Bridge: ${line}`);
    else this.output.appendLine(line);
  }

  logCleanup(action, error) {
    if (error?.code !== "ENOENT") this.log(`${action} failed (${cleanupCode(error)}).`);
  }

  serialize(action) {
    this.lifecycle = this.lifecycle.then(action, action);
    return this.lifecycle;
  }

  register() {
    const register = (name, callback) => {
      this.registrations.push(vscode.commands.registerCommand(`pluelyCopilot.${name}`, callback));
    };
    register("authorize", () => this.authorize());
    register("restart", () => this.command(async () => {
      await this.restart();
      this.log("Bridge restarted.");
      return true;
    }));
    register("status", () => this.command(async () => {
      this.output.show(true);
      await this.start();
      const operation = new Operation(this.run);
      try {
        const health = await this.health(operation);
        const consent = health.consented === null ? "unknown" : health.consented ? "granted" : "not granted";
        this.log(`Listening at ${this.run.baseUrl}; ${health.models.length} Copilot model(s); consent ${consent}.`);
        this.log(`To set up access, run "${AUTHORIZE_COMMAND}". Stable model image capabilities are unavailable.`);
        return health;
      } finally {
        operation.dispose();
      }
    }));
    this.registrations.push(vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (uri.authority === EXTENSION_ID && uri.path === "/setup") await this.authorize();
        else this.log("Ignored an unrecognized bridge setup URI.");
      },
    }));
    const access = this.context.languageModelAccessInformation;
    if (typeof access?.onDidChange === "function") {
      this.registrations.push(access.onDidChange(() => {
        this.knownConsent.clear();
        this.log("Copilot access permissions changed.");
      }));
    }
    this.context.subscriptions.push({
      dispose: () => {
        void this.dispose().catch(() => {
          console.error("Pluely Copilot Bridge cleanup failed; see the extension log.");
        });
      },
    });
  }

  async command(action) {
    try {
      return await action();
    } catch (error) {
      const failure = publicError(error);
      this.log(`Command failed (${failure.code}).`);
      if (!this.disposed) vscode.window.showErrorMessage(failure.message);
      return false;
    }
  }

  start() {
    return this.serialize(() => this.startInternal());
  }

  restart() {
    return this.serialize(async () => {
      await this.stopInternal();
      await this.startInternal();
    });
  }

  async startInternal() {
    if (this.disposed) throw new BridgeError(503, "bridge_stopping", "The bridge has been deactivated.");
    if (this.run) return;
    const run = {
      token: crypto.randomBytes(32).toString("hex"),
      port: 0,
      baseUrl: "",
      connections: new Set(),
      operations: new Set(),
      requestsById: new Map(),
      closing: false,
    };
    run.server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
      void this.handleRequest(run, request, response).catch((error) => {
        this.log(`HTTP response handling failed (${publicError(error).code}).`);
        response.destroy();
      });
    });
    run.server.headersTimeout = 15_000;
    run.server.requestTimeout = REQUEST_TIMEOUT_MS;
    run.server.keepAliveTimeout = 5_000;
    run.server.setTimeout(REQUEST_TIMEOUT_MS, (socket) => socket.destroy());
    run.server.on("connection", (socket) => {
      run.connections.add(socket);
      socket.once("close", () => run.connections.delete(socket));
    });
    run.server.on("error", (error) => this.logCleanup("HTTP server", error));
    this.run = run;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { run.server.off("listening", onListening); reject(error); };
        const onListening = () => { run.server.off("error", onError); resolve(); };
        run.server.once("error", onError);
        run.server.once("listening", onListening);
        run.server.listen(0, "127.0.0.1");
      });
      run.port = run.server.address().port;
      run.baseUrl = `http://127.0.0.1:${run.port}`;
      await this.writeHandshake(run);
      this.log(`Bridge listening at ${run.baseUrl}. No chat panels are opened for HTTP requests.`);
    } catch (error) {
      this.logCleanup("Bridge startup", error);
      await this.stopInternal();
      throw new BridgeError(503, "bridge_start_failed", "The Copilot bridge could not start. See its VS Code output log.");
    }
  }

  async writeHandshake(run) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    let file;
    try {
      file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({
          base_url: run.baseUrl,
          token: run.token,
          pid: process.pid,
          bridge_version: VERSION,
        }));
      } finally {
        try {
          await file.close();
        } catch (error) {
          this.logCleanup("Handshake staging-file close", error);
          throw error;
        }
      }
      await fs.rename(temporary, this.handshake);
    } finally {
      if (file) {
        try {
          await fs.unlink(temporary);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            this.logCleanup("Handshake staging-file cleanup", error);
            throw error;
          }
        }
      }
    }
  }

  async removeHandshake(run) {
    let text;
    try {
      text = await fs.readFile(this.handshake, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      this.log("Handshake cleanup found invalid JSON; the file was left untouched.");
      return;
    }
    if (value?.token !== run.token) {
      this.log("Handshake ownership changed; the file was left untouched.");
      return;
    }
    await fs.unlink(this.handshake);
  }

  async stopInternal() {
    const run = this.run;
    if (!run) return;
    run.closing = true;
    run.requestsById.clear();
    const operations = [...run.operations];
    for (const operation of operations) {
      operation.cancel(new BridgeError(503, "bridge_stopping", "The Copilot bridge is stopping. Reconnect and retry."));
    }
    const failures = [];
    const closed = run.server.listening
      ? new Promise((resolve) => run.server.close((error) => {
        if (error) { this.logCleanup("HTTP server shutdown", error); failures.push(error); }
        resolve();
      }))
      : Promise.resolve();
    for (const socket of run.connections) socket.destroy();
    await closed;
    await Promise.all(operations.map((operation) => operation.finished));
    run.server.removeAllListeners();
    try {
      await this.removeHandshake(run);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logCleanup("Handshake cleanup", error);
        failures.push(error);
      }
    }
    this.run = null;
    if (failures.length) {
      throw new BridgeError(500, "bridge_cleanup_failed", "The bridge stopped, but cleanup failed. See its VS Code output log.");
    }
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.serialize(async () => {
      const failures = [];
      try {
        await this.stopInternal();
      } catch (error) {
        this.logCleanup("Bridge shutdown", error);
        failures.push(error);
      }
      for (const registration of this.registrations) {
        try {
          registration.dispose();
        } catch (error) {
          this.logCleanup("Extension registration cleanup", error);
          failures.push(error);
        }
      }
      this.registrations = [];
      try {
        this.output.dispose();
      } catch (error) {
        this.logCleanup("Output channel cleanup", error);
        failures.push(error);
      } finally {
        this.outputClosed = true;
      }
      if (failures.length) {
        throw new BridgeError(500, "bridge_cleanup_failed", "Bridge cleanup failed. See its VS Code output log.");
      }
    });
    return this.disposePromise;
  }

  async models(operation) {
    if (typeof vscode.lm?.selectChatModels !== "function") {
      throw new BridgeError(503, "vscode_lm_unavailable", "This VS Code version does not provide the Language Model API.");
    }
    const models = await operation.wait(() => vscode.lm.selectChatModels({ vendor: "copilot" }));
    return models.filter((model) => model.vendor === "copilot" && userFacing(model));
  }

  consentFor(model) {
    const access = this.context.languageModelAccessInformation;
    if (typeof access?.canSendRequest === "function") {
      const value = access.canSendRequest(model);
      if (typeof value === "boolean") return value;
    }
    return this.knownConsent.get(model.id) === true ? true : null;
  }

  async health(operation) {
    const models = await this.models(operation);
    const consent = models.map((model) => this.consentFor(model));
    return {
      ok: true,
      copilot_available: models.length > 0,
      consented: consent.includes(true) ? true : consent.includes(false) ? false : null,
      models: models.map((model) => model.id),
      model_details: models.map((model) => ({
        id: model.id,
        name: model.name,
        family: model.family,
        supports_images: supportsImages(model),
      })),
      default_model: models[0]?.id || "",
      bridge_version: VERSION,
      capabilities: { images: models.some((model) => supportsImages(model)), streaming: true, cancellation: true },
    };
  }

  async consume(reply, operation, onText) {
    if (!reply?.text || typeof reply.text[Symbol.asyncIterator] !== "function") {
      throw new BridgeError(502, "invalid_model_response", "Copilot did not return a text response stream.");
    }
    const iterator = reply.text[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const item = await operation.wait(() => iterator.next());
        if (item.done) {
          completed = true;
          return;
        }
        if (typeof item.value !== "string") {
          throw new BridgeError(502, "invalid_model_response", "Copilot returned an invalid text response.");
        }
        await onText(item.value);
      }
    } finally {
      if (!completed && typeof iterator.return === "function") {
        // A provider ignoring cancellation must not keep the HTTP request or shutdown waiting.
        try {
          Promise.resolve(iterator.return()).catch((error) => this.logCleanup("Model stream cleanup", error));
        } catch (error) {
          this.logCleanup("Model stream cleanup", error);
        }
      }
    }
  }

  async handleRequest(run, request, response) {
    let operation;
    let model;
    let requestId;
    const onClose = () => {
      if (!response.writableEnded) operation?.cancel(cancelledError());
    };
    response.on("close", onClose);
    response.on("error", onClose);
    try {
      checkRequest(request, run);
      const route = request.url?.split("?", 1)[0];
      if (!((request.method === "GET" && route === "/health")
        || (request.method === "POST" && ["/v1/chat/completions", "/v1/chat/cancel"].includes(route)))) {
        throw new BridgeError(404, "not_found", "This bridge only provides health, chat completions, and cancellation.");
      }
      operation = new Operation(run);
      if (request.method === "GET") {
        request.resume();
        sendJson(response, 200, await this.health(operation));
        return;
      }
      const body = await readBody(request, operation);
      if (route === "/v1/chat/cancel") {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw invalidRequest("The request must be a JSON object.");
        }
        const target = run.requestsById.get(parseRequestId(body.request_id, true));
        const cancelled = Boolean(target && !target.error && !target.disposed);
        if (cancelled) target.cancel();
        sendJson(response, 200, { cancelled });
        return;
      }
      const payload = parsePayload(body);
      if (payload.requestId !== null) {
        if (run.requestsById.has(payload.requestId)) {
          throw new BridgeError(409, "duplicate_request_id", "request_id is already active. Use a unique UUID for each concurrent request.");
        }
        requestId = payload.requestId;
        run.requestsById.set(requestId, operation);
      }
      const messages = toLmMessages(payload.messages);
      model = chooseModel(await this.models(operation), payload.model, payload.images);
      // A failed request is not access metadata, but must not cause a silent consent retry.
      if (this.knownConsent.get(model.id) === false || this.consentFor(model) !== true) {
        throw new BridgeError(403, "copilot_consent_required",
          `Run "${AUTHORIZE_COMMAND}" in VS Code to authorize Pluely before sending requests.`);
      }
      const reply = await operation.wait(() => model.sendRequest(messages, {}, operation.source.token));
      let text = "";
      await this.consume(reply, operation, async (fragment) => {
        if (payload.stream) {
          await writeSse(response, { choices: [{ index: 0, delta: { content: fragment } }] }, operation);
        } else {
          text += fragment;
        }
      });
      if (operation.error) throw operation.error;
      this.knownConsent.set(model.id, true);
      if (payload.stream) {
        startSse(response);
        response.end("data: [DONE]\n\n");
      } else {
        sendJson(response, 200, {
          id: `pluely-${crypto.randomBytes(8).toString("hex")}`,
          object: "chat.completion",
          model: model.id,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        });
      }
    } catch (error) {
      const failure = publicError(error);
      if (model && error?.code === "NoPermissions") this.knownConsent.set(model.id, false);
      this.log(`HTTP request failed (${failure.code}).`);
      request.resume();
      sendFailure(response, failure);
    } finally {
      response.off("close", onClose);
      response.off("error", onClose);
      if (requestId && run.requestsById.get(requestId) === operation) run.requestsById.delete(requestId);
      operation?.dispose();
    }
  }

  authorize() {
    if (this.authorization) return this.authorization;
    this.authorization = this.command(async () => {
      await this.start();
      const run = this.run;
      return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Authorizing GitHub Copilot for Pluely",
        cancellable: true,
      }, async (_progress, token) => {
        const operation = new Operation(run);
        const subscription = token.onCancellationRequested(() => operation.cancel());
        if (token.isCancellationRequested) operation.cancel();
        let model;
        try {
          model = chooseModel(await this.models(operation), "", false);
          const reply = await operation.wait(() => model.sendRequest(
            [vscode.LanguageModelChatMessage.User("Reply only with ready.")],
            { justification: "Allow Pluely to send your chat requests through your GitHub Copilot subscription in this VS Code window." },
            operation.source.token,
          ));
          await this.consume(reply, operation, async () => {});
          this.knownConsent.set(model.id, true);
          this.log("Copilot authorization completed.");
          if (!this.disposed) vscode.window.showInformationMessage("Pluely can now use GitHub Copilot through this VS Code window.");
          return true;
        } catch (error) {
          if (model && error?.code === "NoPermissions") this.knownConsent.set(model.id, false);
          throw error;
        } finally {
          subscription.dispose();
          operation.dispose();
        }
      });
    }).finally(() => { this.authorization = null; });
    return this.authorization;
  }
}

let activeBridge;
let transition = Promise.resolve();

function enqueueTransition(action) {
  transition = transition.then(action, action);
  return transition;
}

function activate(context) {
  return enqueueTransition(async () => {
    if (activeBridge) {
      await activeBridge.start();
      return;
    }
    const bridge = new Bridge(context);
    try {
      bridge.register();
      await bridge.start();
      activeBridge = bridge;
    } catch (error) {
      await bridge.dispose();
      throw error;
    }
  });
}

function deactivate() {
  return enqueueTransition(async () => {
    const bridge = activeBridge;
    activeBridge = undefined;
    if (bridge) await bridge.dispose();
  });
}

module.exports = { activate, deactivate };
