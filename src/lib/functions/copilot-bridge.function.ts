import { invoke } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import type { Message } from "@/types";
import {
  checkLocalResponse,
  imageDataUrl,
  localServerUrl,
  readBridgeResponse,
} from "../local-provider-transport";

export interface CopilotModel {
  id: string;
  name: string;
  family: string;
  supports_images: boolean;
}

export interface CopilotBridgeStatus {
  source: string;
  ready: boolean;
  message: string;
  models: CopilotModel[];
  default_model: string;
  supports_images: boolean;
  supports_cancellation: boolean;
}

interface ConnectedBridge {
  connection: { base_url: string; token: string };
  status: CopilotBridgeStatus;
}

export function getCopilotBridgeStatus(): Promise<CopilotBridgeStatus> {
  return invoke<CopilotBridgeStatus>("copilot_bridge_status");
}

export function copilotSupportsImages(status: CopilotBridgeStatus, model = ""): boolean {
  if (!status.ready || !status.supports_images) return false;
  if (!model) return status.models.some((entry) => entry.supports_images);
  const selected =
    status.models.find((entry) => entry.id === model) ||
    status.models.find((entry) => entry.family === model || entry.name === model);
  return selected?.supports_images === true;
}

export async function* fetchCopilotResponse(params: {
  model?: string;
  systemPrompt: string;
  history: Message[];
  userMessage: string;
  imagesBase64: string[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  const { model = "", systemPrompt, history, userMessage, imagesBase64, signal } = params;
  if (signal?.aborted) return;
  if (!userMessage.trim()) throw new Error("A question is required.");

  // Rediscover each time: ports and session tokens change when VS Code restarts.
  const { connection, status } = await invoke<ConnectedBridge>("connect_copilot_bridge");
  if (signal?.aborted) return;
  if (imagesBase64.length && !copilotSupportsImages(status, model)) {
    throw new Error(
      "This bridge/model cannot accept images. Remove the attachments or switch to an image-capable provider."
    );
  }

  const baseUrl = localServerUrl(connection.base_url);
  const requestId = crypto.randomUUID();
  const headers = {
    Authorization: `Bearer ${connection.token}`,
    "Content-Type": "application/json",
  };
  const controller = new AbortController();
  const requestController = new AbortController();
  let receivedHeaders = false;
  const cancel = () => {
    controller.abort();
    if (!receivedHeaders) requestController.abort();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let completed = false;
  let started = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 180_000);
  try {
    const messages: Message[] = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...history,
      {
        role: "user",
        content: imagesBase64.length
          ? [
              { type: "text", text: userMessage },
              ...imagesBase64.map((image) => ({
                type: "image_url",
                image_url: { url: imageDataUrl(image) },
              })),
            ]
          : userMessage,
      },
    ];
    started = true;
    const response = await nativeFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      // Legacy bridges need a pending HTTP request for native cancellation to reach the model.
      body: JSON.stringify({
        request_id: requestId,
        model,
        messages,
        stream: status.supports_cancellation,
      }),
      signal: requestController.signal,
      connectTimeout: 5_000,
      maxRedirections: 0,
    });
    receivedHeaders = true;
    yield* readBridgeResponse(response, controller.signal);
    if (timedOut) throw new Error("Copilot did not complete the response within 3 minutes.");
    completed = !signal?.aborted;
  } catch (error) {
    if (signal?.aborted) return;
    if (timedOut) throw new Error("Copilot did not complete the response within 3 minutes.");
    throw new Error(
      `Copilot bridge: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    if (!completed) cancel();
    if (!completed && started && status.supports_cancellation) {
      const cancellation = new AbortController();
      const deadline = setTimeout(() => cancellation.abort(), 5_000);
      try {
        const response = await nativeFetch(`${baseUrl}/v1/chat/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify({ request_id: requestId }),
          signal: cancellation.signal,
          connectTimeout: 3_000,
          maxRedirections: 0,
        });
        await checkLocalResponse(response);
        await response.text();
      } catch (error) {
        console.error("Failed to cancel the Copilot bridge task:", error);
      } finally {
        clearTimeout(deadline);
      }
    }
  }
}
