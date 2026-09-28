import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { DEFAULT_WHISPER_URL } from "@/config/local-providers.constants";
import { checkLocalResponse, isRecord, localServerUrl } from "../local-provider-transport";
import { floatArrayToWav } from "../utils";

export async function checkLocalWhisper(
  baseUrl = DEFAULT_WHISPER_URL,
  signal?: AbortSignal
): Promise<void> {
  const url = localServerUrl(baseUrl);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) throw new DOMException("Transcription cancelled.", "AbortError");
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await nativeFetch(`${url}/health`, {
      signal: controller.signal,
      connectTimeout: 3_000,
      maxRedirections: 0,
    });
    await checkLocalResponse(response);
    const health: unknown = await response.json();
    if (!isRecord(health) || health.status !== "ok") {
      throw new Error("The local server is not a ready whisper.cpp server.");
    }
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Transcription cancelled.", "AbortError");
    throw new Error(
      `Local Whisper is not ready at ${url}. Start whisper-server with a model, then use Check connection in Dev Space > STT Providers. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function transcribeLocalWhisper(
  audio: Blob,
  variables: Record<string, string>,
  signal?: AbortSignal
): Promise<string> {
  const baseUrl = localServerUrl(variables.base_url ?? DEFAULT_WHISPER_URL);
  if (!audio.size) throw new Error("Cannot transcribe an empty recording.");
  await checkLocalWhisper(baseUrl, signal);
  if (audio.size > 25 * 1024 * 1024) {
    throw new Error("Local Whisper recordings must be smaller than 25 MB.");
  }

  // Both MediaRecorder (WebM/Ogg) and system capture (WAV) become 16 kHz mono PCM.
  const decoder = new OfflineAudioContext(1, 1, 16000);
  const decoded = await decoder.decodeAudioData(await audio.arrayBuffer());
  const samples = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const values = decoded.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) {
      samples[index] += values[index] / decoded.numberOfChannels;
    }
  }
  if (signal?.aborted) throw new DOMException("Transcription cancelled.", "AbortError");
  const form = new FormData();
  form.append("file", floatArrayToWav(samples, 16000), "recording.wav");
  form.append("response_format", "json");
  form.append("language", variables.language?.trim() || "auto");

  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 180_000);
  try {
    const response = await nativeFetch(`${baseUrl}/inference`, {
      method: "POST",
      body: form,
      signal: controller.signal,
      connectTimeout: 5_000,
      maxRedirections: 0,
    });
    await checkLocalResponse(response);
    const result: unknown = await response.json();
    if (!isRecord(result) || typeof result.text !== "string") {
      throw new Error("Local Whisper returned an invalid transcription.");
    }
    if (!result.text.trim()) throw new Error("No speech was recognized in this recording.");
    return result.text.trim();
  } catch (error) {
    if (timedOut) throw new Error("Local Whisper transcription timed out after 3 minutes.");
    if (signal?.aborted) throw new DOMException("Transcription cancelled.", "AbortError");
    throw new Error(`Local Whisper: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}
