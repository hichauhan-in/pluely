# Copilot bridge and local speech-to-text

This source checkout is Pluely 0.1.9, not the proprietary v1 described by the
upstream README. The existing API-key providers still work. Two additional
providers allow a key-free setup:

- **GitHub Copilot (VS Code Bridge)** for AI replies, using your existing Copilot
  access through VS Code's supported Language Model API.
- **Local Whisper (no API key)** for speech recognition using `whisper.cpp`.

These are independent choices: Copilot also works with an existing cloud STT
provider, and local Whisper also works with an existing AI provider. Explicitly
selecting either new provider takes precedence over the corresponding hosted
Pluely service. Errors never trigger a silent switch to a paid API provider.

## Connect Copilot

1. Open **Dev Space > AI Providers** and select **GitHub Copilot (VS Code Bridge)**.
2. Pluely checks the current user's local bridge handshakes. Existing
   Editor/ClipDesk and DotPML bridges can be reused without copying API keys,
   ports, or paths.
3. If no bridge is ready, install/open **Visual Studio Code 1.95 or newer** (or Insiders) and
   sign in to GitHub Copilot. This integration is for VS Code, not the separate
   Visual Studio IDE.
4. Choose your editor edition and click **Install / update bridge**. The
   companion extension is bundled into the desktop app; this does not require
   the source repository, Node.js, npm, admin access, or the `code` CLI on the
   destination machine.
5. Run **Developer: Reload Window** in VS Code once so it notices the newly
   installed extension.
6. Click **Authorize in VS Code**, or run **Pluely: Authorize Copilot Access**
   from VS Code's command palette. Accept the normal Copilot access prompt.
7. Click **Check connection** in Pluely, then choose **Auto** or a model from the
   live catalogue.

After setup, leave VS Code running; it can be minimized. Ordinary requests use
the extension directly, without opening a chat tab, inserting text into the
editor, or bringing VS Code to the foreground. This is background language-model
inference, not a terminal agent or arbitrary command-execution bridge.

First-time installation, sign-in, and permission prompts cannot be hidden or
bypassed. Copilot subscription quotas, model availability, organization policies,
and content restrictions still apply. VS Code must be running on the same
machine as Pluely.

### Discovery, portability, and cancellation

The Pluely extension binds only to `127.0.0.1` on an automatically assigned port.
Each local VS Code extension host writes its own authenticated handshake under
`~/.pluely/bridges/<process-id>.json`. Multiple windows can coexist. The extension
runs on the local UI host, including when VS Code is connected to a remote
workspace.

Pluely also recognizes `~/.clipdesk/bridge.json` and `~/.dotpml/bridge.json`.
It prefers a ready Pluely bridge, then a compatible existing bridge. Dead
handshakes are skipped; if no bridge is usable, the setup error is shown.
Ports and session tokens are rediscovered and health-checked before each AI
request, rather than saved in Pluely settings. No user-specific development path
is embedded in the app.

Stopping a Pluely bridge response cancels the corresponding Copilot request.
Requests also have a three-minute limit. Both streamed responses and older
bridges' non-streamed responses are supported. Authorization failures,
unavailable models, incomplete streams, and service errors are displayed, not
saved as successful answers.

Only a loopback address from a validated handshake is accepted. The bridge uses
a random per-session bearer token, rejects browser-originated requests, limits
request size, and does not read private Copilot credentials. The bundled
extension adds no telemetry. Pluely's pre-existing analytics are unchanged.

### Screenshots and images

The current bundled bridge is **text-only**. VS Code's stable Language Model API
does not expose reliable per-model image capability information. The extension
does not enable proposed APIs, guess vision support from model names, or silently
discard attachments.

Copilot through this bridge handles typed questions and transcribed speech.
Screenshots still require an image-capable provider from the existing provider
options. Older Editor/ClipDesk and DotPML bridges are also treated as text-only
unless they explicitly advertise image support. The client understands image
capability metadata for compatible bridges, but installing the current Pluely
extension does not add screenshot support.

### Non-standard VS Code installations

The in-app installer targets the standard user extension directory:
`~/.vscode/extensions` or `~/.vscode-insiders/extensions`. For portable VS Code,
custom profiles with a different extensions directory, or enterprise-managed
installations, install the two files in [vscode-bridge](../vscode-bridge) manually
into a `pluely.pluely-copilot-bridge-0.1.0` directory under that installation's
extensions directory, then reload VS Code. Follow your organization's extension
installation policy.

## Set up local Whisper

Copilot's Language Model API does **not** transcribe audio. Local Whisper supplies
this part without an API key.

1. Install a current [whisper.cpp](https://github.com/ggml-org/whisper.cpp) build
   containing **whisper-server** for your operating system. The official
   [server guide](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server)
   covers building the executable if a suitable release binary is unavailable.
2. Download a compatible GGML model from the
   [official model repository](https://huggingface.co/ggerganov/whisper.cpp/tree/main).
   `ggml-base.bin` is a reasonable multilingual starting point.
   `ggml-base.en.bin` is English-only. Larger models need more memory and time.
3. Start the server as a normal user, bound only to loopback. For example, in
   PowerShell from your whisper.cpp installation:

   ```powershell
   .\whisper-server.exe -m .\models\ggml-base.bin --host 127.0.0.1 --port 8080
   ```

   If you built it from source, the executable may be under
   `build\bin\Release`. On macOS/Linux, use the corresponding `whisper-server`
   executable with the same arguments.

4. Open **Dev Space > STT Providers**, select **Local Whisper (no API key)**, and
   leave the address as `http://127.0.0.1:8080` unless you chose a different port.
5. Use `auto` for language detection, or set a language such as `en` or `hi`.
   English-only models require English audio.
6. Click **Check connection**. Whisper must have loaded its model and report
   ready before transcription can begin.

Keep the server running in the background while using voice input. Pluely does
not download large models, launch arbitrary executables, or register a system
service automatically. Repeat runtime/model setup on each new machine.

Microphone recordings (including WebM/Ogg) and system-audio recordings are
converted to 16 kHz, mono, 16-bit PCM WAV before upload to the local server;
FFmpeg is not required. The integration uses `/health` and `/inference`.
Only numeric loopback HTTP addresses with an explicit port are accepted.
Do not expose the Whisper server to the network or run it as administrator.

Audio stays on the machine for transcription. The resulting **text** is sent to
the selected AI provider, including Copilot when enabled. This setup is not
fully offline: Copilot inference still uses GitHub's service.

## Development checks

### Windows executable

With Node.js, Rust/Cargo on `PATH`, and the Windows native build prerequisites
installed, build the desktop application from the repository root:

```powershell
npm run tauri -- build --no-bundle
```

The executable is `src-tauri\target\release\pluely.exe`. `npm run build` alone
only builds the frontend. `--no-bundle` skips installer generation and updater
signing.

For a GNU-toolchain build, keep the generated `WebView2Loader.dll` next to
`pluely.exe` when moving the application to another machine. The destination
needs the Microsoft Edge WebView2 runtime, but does not need Node.js or Rust.
VS Code/Copilot and local Whisper have the separate setup requirements above.

This development fork still has the original upstream updater. Installing an
upstream Pluely update would replace these custom changes; rebuild this branch
to update the customized application instead.

### Automated checks

From the repository root:

```powershell
npm ci
npm test
npm run build
npm run test:native
```

The Node tests use the existing TypeScript dependency and Node's built-in test
runner, with mocked model access and temporary loopback servers; they do not
consume Copilot quota or access real recordings. Native tests require the normal
Tauri/Rust build prerequisites and exercise the shared discovery/installation
module without loading the desktop GUI into the test process.

For an end-to-end check, select the new providers, authorize the bridge, start
Whisper, send a short text question, then try a microphone question. Test
screenshots separately with an image-capable API provider. Also stop/restart VS Code and Whisper:
Pluely should show a setup/connection error while they are unavailable and
rediscover them when they return. Do not reload another user's editor session
just to perform a test.
