import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Header, Input } from "@/components";
import { DEFAULT_WHISPER_URL } from "@/config";
import { checkLocalWhisper } from "@/lib/functions/local-whisper.function";

export const LocalWhisper = ({
  variables,
  onChange,
}: {
  variables: Record<string, string>;
  onChange: (variables: Record<string, string>) => void;
}) => {
  const baseUrl = variables.base_url ?? DEFAULT_WHISPER_URL;
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setReady(false);
    setError("");
    const timer = setTimeout(() => {
      checkLocalWhisper(baseUrl, controller.signal)
        .then(() => {
          if (!controller.signal.aborted) setReady(true);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(String(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl, revision]);

  const openGuide = async (url: string) => {
    try {
      await openUrl(url);
    } catch (reason) {
      setError(`Could not open setup instructions: ${String(reason)}`);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-input/50 p-4">
      <Header title="Local Whisper" description="Transcribe on this machine using whisper.cpp. No API key is needed and audio is not uploaded to a cloud STT service." />
      <label className="block space-y-1 text-sm">
        <span>Local server address</span>
        <Input
          value={baseUrl}
          placeholder={DEFAULT_WHISPER_URL}
          onChange={(event) => onChange({ ...variables, base_url: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Spoken language (auto, en, hi, ...)</span>
        <Input
          value={variables.language ?? "auto"}
          onChange={(event) => onChange({ ...variables, language: event.target.value })}
        />
      </label>
      <p className="text-sm" role="status">
        {busy ? "Checking local Whisper..." : ready ? "Whisper is ready. Its connection is checked before each transcription." : "Whisper setup is required."}
      </p>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <Button variant="outline" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
        Check connection
      </Button>
      <Header title="One-time setup on each machine" description="The speech runtime and model are separate downloads, not included in Pluely." />
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Install whisper.cpp with the whisper-server executable for your OS.</li>
        <li>Download a GGML Whisper model. Start with ggml-base.bin for multiple languages, or ggml-base.en.bin for English only.</li>
        <li>Start the server bound to loopback using the command below, then check the connection.</li>
      </ol>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
        {"whisper-server -m <model-file> --host 127.0.0.1 --port 8080"}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => openGuide("https://github.com/ggml-org/whisper.cpp/tree/master/examples/server")}>
          Runtime setup guide
        </Button>
        <Button variant="outline" onClick={() => openGuide("https://huggingface.co/ggerganov/whisper.cpp/tree/main")}>
          Download a model
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Keep whisper-server running in the background as a normal user. Pluely converts recordings to 16 kHz mono WAV automatically; FFmpeg is not required. This selection takes precedence over hosted Pluely transcription. Transcribed text is still sent to your selected AI provider.
      </p>
    </div>
  );
};
