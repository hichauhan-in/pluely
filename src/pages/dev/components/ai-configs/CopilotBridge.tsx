import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Header, Selection } from "@/components";
import { useApp } from "@/contexts";
import {
  CopilotBridgeStatus,
  copilotSupportsImages,
  getCopilotBridgeStatus,
} from "@/lib/functions/copilot-bridge.function";

export const CopilotBridge = ({
  variables,
  onChange,
}: {
  variables: Record<string, string>;
  onChange: (variables: Record<string, string>) => void;
}) => {
  const { setSupportsImages } = useApp();
  const [status, setStatus] = useState<CopilotBridgeStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const model = variables.model || "";
  const editor = variables.editor || "vscode";

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    getCopilotBridgeStatus()
      .then((result) => {
        if (active) setStatus(result);
      })
      .catch((reason: unknown) => {
        if (active) {
          setStatus(null);
          setError(String(reason));
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    setSupportsImages(status ? copilotSupportsImages(status, model) : false);
  }, [status, model]);

  const setup = async (install: boolean) => {
    setActionBusy(true);
    setError("");
    setNotice("");
    try {
      if (install) {
        setNotice(await invoke<string>("install_copilot_bridge", { editor }));
      } else {
        await invoke("open_copilot_bridge", { editor });
        setNotice("Finish authorization in VS Code, then check the connection below.");
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setActionBusy(false);
    }
  };

  const options = [
    { label: "Auto (available Copilot model)", value: "auto" },
    ...(status?.models.map((entry) => ({
      label: `${entry.name || entry.id}${entry.supports_images ? " (images)" : ""}`,
      value: entry.id,
    })) || []),
  ];
  if (model && !options.some((option) => option.value === model)) {
    options.push({ label: `${model} (unavailable - select another model)`, value: model });
  }

  return (
    <div className="space-y-3 rounded-lg border border-input/50 p-4">
      <Header
        title="Connect through VS Code"
        description="Use your GitHub Copilot access without an AI-provider API key. Requests run through the extension, not a visible chat panel. Copilot plan limits still apply."
      />
      <p className="text-sm" role="status">
        {busy ? "Checking this machine for a bridge..." : status?.message}
      </p>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {notice ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}
      <Button variant="outline" disabled={busy || actionBusy} onClick={() => setRevision((value) => value + 1)}>
        Check connection
      </Button>
      <Header title="Copilot model" description="Models come from the connected VS Code session. An unavailable explicit selection is never silently replaced." />
      <Selection
        selected={model || "auto"}
        options={options}
        disabled={busy || !status?.ready}
        onChange={(value: string) => onChange({ ...variables, model: value === "auto" ? "" : value })}
      />
      {status?.ready && !copilotSupportsImages(status, model) ? (
        <p className="text-sm text-muted-foreground">
          This connection is text-only. Screenshots require an image-capable provider; the current Pluely bridge does not enable image input.
        </p>
      ) : null}
      <Header title="First-time setup on this machine" description="Existing Editor/ClipDesk and DotPML bridges are discovered automatically. Otherwise install the bundled Pluely extension below." />
      <Selection
        selected={editor}
        disabled={actionBusy}
        options={[
          { label: "Visual Studio Code", value: "vscode" },
          { label: "Visual Studio Code Insiders", value: "vscode-insiders" },
        ]}
        onChange={(value: string) => onChange({ ...variables, editor: value })}
      />
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Install and open VS Code 1.95 or newer, then sign in to GitHub Copilot.</li>
        <li>Install this bridge and run Developer: Reload Window in VS Code once.</li>
        <li>Authorize access in VS Code, then check the connection.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={actionBusy} onClick={() => setup(true)}>
          Install / update bridge
        </Button>
        <Button disabled={actionBusy} onClick={() => setup(false)}>
          Authorize in VS Code
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Keep VS Code running; it may be minimized after setup. No provider keys or machine-specific paths are copied to another machine. This selection takes precedence over the hosted Pluely AI service.
      </p>
    </div>
  );
};
