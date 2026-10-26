# Security

Winged Keys is a Stream Dock / Stream Deck plugin that talks to Hermes Agent running on your own PC. Because Hermes can run commands on your PC, this page lists every sensitive thing the plugin does: what it reads, when, where data goes, and what it starts. Every statement here is checked against the code in `src/index.js` and `propertyInspector/index.html`.

## Reporting a problem

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/overture-sys/winged-keys/security/advisories/new) for this repository, not in a public issue.

## Where data goes

**With the default settings, the plugin only connects to your own PC.** Every web request goes through one function (`safeFetch`) that:

- allows only `127.0.0.1`, `localhost` and `::1`;
- refuses redirects, so a local service can't send the request on to another host;
- stops after 8 seconds (or the set timeout) and refuses replies over 2 MB.

The plugin connects to three local services, all at addresses you set:

| Service | What the plugin sends | When |
|---|---|---|
| Hermes API (default `http://127.0.0.1:8642`) | Your Hermes API key (as `Authorization: Bearer`), Ask prompts, clipboard text (only if you turned it on, see below), run polls, approval answers | Status keys every 30 s, key presses, **Test connection** |
| Hermes dashboard (default `http://127.0.0.1:9119`) | Plain page and status requests, plus the dashboard's own session token | Usage and Platforms keys every 60 s, **Find Hermes**, **Test connection** |
| Stream Dock / Stream Deck app | Key images, settings, messages to the settings panel | Always (local WebSocket on `127.0.0.1`) |

The Hermes API key is never sent to the dashboard.

Things that can take data off your PC, and only these:

1. **Hermes itself.** The plugin hands your Ask prompt (and clipboard text, if turned on) to Hermes on your PC. Hermes then sends it to whichever AI model provider you set up in Hermes, as it does for any chat. The plugin does not control that step.
2. **"Allow a non-local address"** (off by default). If you tick it, the plugin will also connect to a non-local Hermes or dashboard address, over `https` only. Your API key and prompts then go to that address.
3. **Links you open.** Open keys, **New chat** with "Also open the Hermes WebUI", and the **Support on Ko-fi** link ask the Stream Dock app to open a web address in your browser. Only `http` and `https` addresses are opened. The plugin sends no data with them.

The plugin has no analytics, telemetry, update check or crash reporting.

## Optional features (off by default)

Two features read sensitive things on your PC. Both are **off** until you tick them under **Optional features** in the settings panel. While they are off, the plugin does not do them at all.

### Read key from Hermes

- **What is read:** your Hermes `.env` file (default `%LOCALAPPDATA%\hermes\.env` on Windows, `~/.hermes/.env` elsewhere, or a location you set), and `profiles\<agent>\.env` for each agent folder next to it.
- **What is kept:** only the value of `API_SERVER_KEY` from each file. From the main file it also checks whether `API_SERVER_ENABLED` is true, to warn you if the API server is off. Every other line (your other secrets) is read into memory, ignored, and dropped. Agent `.env` files over 1 MB are skipped.
- **When:** only when you click **⚠ Read key from Hermes** and then **Yes, read my key** on the warning. Never on its own.
- **Where it goes:** the keys are saved in the plugin's settings, which the Stream Dock / Stream Deck app stores (possibly unencrypted). The settings panel is told which agents have a key, never the key itself. Keys are never logged or shown on a key.
- **Limits:** the location must be a full local path ending in `.env`. Network paths (`\\server\share`) are refused. The location comes only from your setting or the standard one, never from the dashboard.
- **When it's off:** the button and the `.env` location box are hidden, and the plugin refuses the command. You can still paste the main key into the API key box. Named agents need their own key, which is only picked up this way, so turn it on once if you use the Agent key with named agents.

### Ask with clipboard

- **What is read:** the text on your clipboard.
- **When:** only when you press an Ask key that has **Add the clipboard text to the prompt** ticked, and only while **Ask with clipboard** is on. One read per press.
- **How:** neither the Stream Dock nor the Elgato Stream Deck plugin API offers a way for plugins to read the clipboard (we checked the Elgato event and command reference and the MiraBox Stream Dock SDK). So the plugin runs a fixed command, never through a shell:
  - Windows: `powershell.exe -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"`
  - macOS: `pbpaste`
  - Other systems: not supported; the clipboard is treated as empty.

  The command times out after 5 seconds.
- **Where it goes:** up to the first 20,000 characters are added to the prompt and sent to Hermes (see "Where data goes"). The reply file notes "(with clipboard text)" but does not contain the clipboard text. Clipboard text is never logged.
- **When it's off:** an Ask key with the clipboard box ticked shows *clipboard off*, alerts, and sends nothing. The clipboard is not read.
- Don't use it with passwords or private text on the clipboard.

## Other things the plugin reads

| What | When | Why |
|---|---|---|
| The dashboard's web page, to find its session token (`__HERMES_SESSION_TOKEN__`) | Usage keys, when the token is missing or refused | The dashboard's usage numbers need it, the same way your browser gets it. Kept in memory only, never saved, logged or shown. |
| Folder names in `<Hermes home>\profiles` (names only, not contents) | Pressing the Agent key | To list your agents. |
| File names in your reply folder | Open key set to "Latest Ask reply" | To find the newest `ask-*.md` file. |
| Whether `%LOCALAPPDATA%\hermes\bin\hermes.exe` exists | Pressing a Usage key while the dashboard is off | To start the dashboard (see below). |

## Files the plugin writes

- **Ask replies:** `%USERPROFILE%\WingedKeys\replies\ask-YYYYMMDD-HHMMSS.md`, or a folder you set. Each holds the key's prompt, the model that answered, and the reply. Existing files are never overwritten.
- **Log:** `%USERPROFILE%\WingedKeys\plugin.log` (rotated at 1 MB). It records event names, setting *names* (never values), and short notes such as "agent switched". Unexpected errors are logged by name and message (up to 200 characters). Keys, prompts, clipboard text, replies and approval previews are never logged.
- **Settings:** saved through the Stream Dock / Stream Deck app, which decides where and how they are stored.

## Programs the plugin starts

Always with fixed arguments and never through a shell:

- `hermes.exe dashboard --no-open --port <port>`, when you press a Usage or Platforms key and the dashboard is off. Turn this off with "Pressing a Usage key starts the dashboard if it is off". The path is the standard one or a full local path you set; on Windows the plugin never falls back to searching `PATH`.
- `explorer.exe <file>` (`open` on macOS, `xdg-open` on Linux), to open the newest reply file from an Open key.
- The clipboard command above, only with **Ask with clipboard** on.

## Approvals

The plugin never approves anything on its own. The **Approve** key answers only when you press it, only for the exact request it has shown for at least 1.5 seconds (checked with Hermes again just before answering), only for runs started from your own Ask keys, and only with *once* or *deny*, never *session* or *always*.

## The settings panel

- **Make a key** creates a random key in the panel (`crypto.getRandomValues`) and shows it in plain text. Don't use it while streaming or sharing your screen.
- **Copy lines** puts the two `.env` lines on your clipboard, only when you click it.
- The panel makes no web requests of its own. It only talks to the Stream Dock app.

## Your part

- Keep the Hermes API server on `127.0.0.1`. It gives the agent full tool access, including terminal commands. Don't expose it to the internet.
- Treat the API key like a password.
