import { invoke } from "@tauri-apps/api/core";
import { COPILOT_PROVIDER_ID, LOCAL_WHISPER_PROVIDER_ID } from "@/config/local-providers.constants";
import { checkLocalWhisper } from "./local-whisper.function";

export async function checkLocalProviderSetup(
  ai: { provider: string },
  speech: { provider: string; variables: Record<string, string> }
): Promise<void> {
  if (ai.provider === COPILOT_PROVIDER_ID) {
    await invoke("connect_copilot_bridge");
  }
  if (speech.provider === LOCAL_WHISPER_PROVIDER_ID) {
    await checkLocalWhisper(speech.variables.base_url);
  }
}
