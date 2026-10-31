# Changelog

## Unreleased
- The source code now lives on GitLab at https://gitlab.com/overture-group1/Overture-project while the GitHub copy is unavailable. README and SECURITY.md point there; security problems can be reported in a confidential GitLab issue or a private Ko-fi message. No plugin changes.

## 0.13.1 beta (Elgato Marketplace build, 2026-10-31)
Elgato Stream Deck build only; the Stream Dock build is unchanged at 0.13.0. Changes to meet Elgato's Marketplace plugin guidelines:
- The settings panel no longer has the "Support on Ko-fi" link (Marketplace does not allow donation links there). It has a **Setup help** link to the README instead.
- The Approve and Model icons in the Stream Deck actions list are now white like the others (the guidelines ask for white, single-colour list icons).
- The settings panel says "Stream Deck" instead of "Stream Dock", and points to SECURITY.md on GitLab.
- The manifest lists Windows only, since the plugin has only been tested on Windows. macOS can come back once it is tested.

## 0.13.0 beta (2026-10-26)
Public beta, pay what you want on Ko-fi: https://ko-fi.com/s/f9fabd5616. Includes the 0.11.0 and 0.12.0 changes below.
- **Read key from Hermes**, **Ask with clipboard** and **Start the dashboard from Usage keys** are now opt-in, off by default. Turn them on under the new **Optional features** section in the settings panel. While off, the Read key button is hidden and refused, and an Ask key set to use the clipboard shows *clipboard off* and sends nothing, and Usage and Platforms keys show *dashboard off* instead of starting the dashboard. The old "starts the dashboard" setting (on by default) is replaced and ignored. If you used any of these before, tick it once after updating.
- New `SECURITY.md`: exactly what the plugin reads, when, where data goes, and which programs it starts.
- Clipboard reading still uses PowerShell on Windows: neither the Stream Dock nor the Stream Deck plugin API offers a clipboard read.

## 0.12.0 beta (2026-10-25, not released on its own; shipped in 0.13.0)
- **Model** key: switch which model Hermes uses for Ask keys. Press to step through Hermes's own default and the models you list in the settings panel (`model` or `provider:model`); turning a dial steps both ways. Each Ask run sends the chosen `model` (and `provider`) to Hermes; Hermes's default model is not changed.
- Ask reply files name the provider and model that actually answered.
- Test connection names the chosen model.

## 0.11.0 beta (2026-10-25, not released on its own; shipped in 0.13.0)
- **Approve** key: shows the approval request an Ask run is waiting on (the command, or what the agent wants to do) and approves it **once** when you press it. Never answers on its own, never chooses "session" or "always", and ignores a press in the first 1.5 seconds after a new request appears. Can be set to **Deny** instead.
- Uses Hermes's `POST /v1/runs/{id}/approval` with the exact request id (and execution generation on current Hermes).

## 0.10.0 beta (2026-10-25)
- **Agent** key: switch which Hermes agent (profile) the keys talk to. Requests go to `/p/<agent>/` with that agent's own key.
- **New chat** key, and a per-key **Continue the conversation** option for Ask keys.
- **Read key from Hermes** also reads each agent's `API_SERVER_KEY` and lists agents that still need one.
- Status and Test connection explain when an agent needs its own key.
- New README banner and key showcase.

## 0.9.2 beta (2026-10-25)
- Brighter captions under the key text.

## 0.9.1 beta (2026-10-25)
- Bigger key text by default, and a **Key text size** setting (Normal, Large, Extra large).

## 0.9.0 beta (2026-10-25)
- New look: Greek gold. Keys are drawn with Roman capitals (Cinzel) and gold accents on dark plaques, with new icons (a goblet for Ask, a temple for Usage) and a laurel-and-wing mark.
- Text is drawn as shapes on the key, so it looks the same on every device.
- Restyled settings panel.
- Bundles the Cinzel typeface (SIL Open Font License 1.1, see `Cinzel-OFL.txt`).

## 0.8.1 beta (2026-10-25)
- Fix: Usage keys only counted the default Hermes profile, so "today" showed 0 when your agents (Morpheus etc.) did the work. Usage now adds up every agent by default, and each Usage key can be set to a single agent.

## 0.8.0 beta (2026-10-25)
First public beta. MIT license. Support link (Ko-fi) in the settings panel and README.
- Dial support: Stream Dock N3/N4 knobs and touch strip, Elgato Stream Deck+ dials. Pressing a dial works like pressing a key; turning a Usage dial changes the metric.
- Security fixes from an independent review:
  - Redirects are refused on every request, so a local service can't bounce requests (and prompt or clipboard text) to another host.
  - **Find Hermes** no longer runs on its own. It proposes an address (after checking it answers like Hermes) and saves it only when you click **Use this address**.
  - Stop only shows "stopped" when Hermes accepted the stop.
  - **Read key from Hermes** reads only the standard Hermes `.env` or a location you set; it no longer takes a path from the dashboard, and network paths are refused.
  - Two quick presses of Ask can no longer start two runs; Stop now also stops a run that is still being created.
  - Remote addresses (when allowed) must use https.
  - Response size and time limits; Ask timeout capped at one hour.
  - WebSocket client: frame and message size limits and handshake check.
  - On Windows, the dashboard is started only from a full path to hermes.exe (no PATH lookup).
  - Log file is rotated at 1 MB; reply files never overwrite each other.

## 0.7.0 (2026-10-25)
- Easier setup in the settings panel: **Find Hermes** (auto-detects the API address from the dashboard), **Test connection** (plain-language checks), first-time setup steps with **Make a key** and **Copy lines**.
- **Read key from Hermes** button: after a warning and a second click, reads only `API_SERVER_KEY` from your Hermes `.env`.
- Status key says why Hermes is unreachable (gateway off, API off).
- The Hermes API address is detected automatically on first run.

## 0.6.0 (2026-10-25)
- Renamed to Winged Keys (`com.wingedkeys.hermes`). Reply folder is now `WingedKeys\replies`.

## 0.5.1 (2026-10-23)
- Ask key shows "needs OK" while the agent waits for approval or clarification. The plugin never approves for you.
- Elgato Stream Deck build (same code, Elgato manifest and images). Simulated tests only.

## 0.5.0 (2026-10-23)
- Renamed to "Winged Keys" (`com.wingedkeys.hermes`).
- New keys: Platforms, Open. Ask can add clipboard text.

## 0.4.0
- Usage key starts the Hermes dashboard if it is off.

## 0.3.0
- Usage: cache hit %, tokens, sessions, model calls from dashboard analytics.

## 0.2.0
- Usage key from the dashboard status (API tokens, requests, p95, agents running).

## 0.1.0
- Status, Ask, Stop keys.
