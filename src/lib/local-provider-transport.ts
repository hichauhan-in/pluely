export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function localServerUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use a local server address such as http://127.0.0.1:8080, without a path or credentials."
    );
  }
  return url.origin;
}

function responseError(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return undefined;
}

export async function checkLocalResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text();
  let message = text.slice(0, 1000);
  try {
    message = responseError(JSON.parse(text)) || message;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new Error(`Local service returned HTTP ${response.status}: ${message || response.statusText}`);
}

function chatContent(payload: unknown, streaming: boolean): string | undefined {
  const error = responseError(payload);
  if (error) throw new Error(error);
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("The bridge returned an invalid chat response.");
  }
  const choice: unknown = payload.choices[0];
  if (!isRecord(choice)) throw new Error("The bridge returned no chat choice.");
  const message = streaming ? choice.delta : choice.message;
  if (!isRecord(message)) throw new Error("The bridge returned an invalid chat message.");
  if (typeof message.content === "string") return message.content;
  if (streaming && (message.content === undefined || message.content === null)) {
    return undefined;
  }
  throw new Error("The bridge returned no response text.");
}

async function drainBridgeBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (!(await reader.read()).done) {
      // Tauri's HTTP channel still delivers its EOF after DONE or an explicit bridge cancellation.
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* readBridgeResponse(
  response: Response,
  signal?: AbortSignal
): AsyncIterable<string> {
  await checkLocalResponse(response);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const content = chatContent(await response.json(), false);
    if (!content?.trim()) throw new Error("The bridge returned an empty response.");
    yield content;
    return;
  }
  if (!response.body) throw new Error("The bridge returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let receivedText = false;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (signal?.aborted) return;
      buffer += done ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        } else if (!line && data.length) {
          const event = data.join("\n");
          data = [];
          if (event === "[DONE]") {
            if (!receivedText) throw new Error("The bridge returned an empty response.");
            return;
          }
          const content = chatContent(JSON.parse(event), true);
          if (content) {
            receivedText = receivedText || content.trim().length > 0;
            yield content;
          }
        }
      }
      if (done) {
        if (signal?.aborted) return;
        throw new Error("The bridge disconnected before completing the response. Please retry.");
      }
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    drainBridgeBody(reader).catch((error: unknown) => {
      console.error("Failed to finish reading the bridge response:", error);
    });
  }
}

export function imageDataUrl(image: string): string {
  if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(image)) return image;
  const mime = image.startsWith("iVBORw0KGgo")
    ? "png"
    : image.startsWith("/9j/")
      ? "jpeg"
      : image.startsWith("R0lGOD")
        ? "gif"
        : image.startsWith("UklGR")
          ? "webp"
          : undefined;
  if (!mime) throw new Error("Copilot image attachments must be PNG, JPEG, WebP, or GIF.");
  return `data:image/${mime};base64,${image}`;
}
