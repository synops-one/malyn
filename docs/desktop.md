# Tray and local admin UI

## Screenshot mode and notifications

The tray and Preferences expose **Screenshot mode — analyse new clipboard images**. It is off by default and persists only when you explicitly enable it. While the tray runs, it polls the clipboard sequence number every three seconds and reads image data only after a change while enabled. Existing clipboard contents at startup or enable time are ignored. Text and file lists are not collected. There is no timed screen capture, background clipboard archive or cloud upload.

New images are saved as PNG in `captures/` beside the configuration and submitted through the same selected-file boundary as Ask Malyn. The configured model is loaded on the selected GPU if needed. Images over 10 MiB are rejected. If `allowedRoots` is restricted, the captures directory must be within an allowed root; Malyn does not expand it automatically. Paused/busy workers skip the image with a notice; this release does not maintain a screenshot queue.

The tray requests a Windows notification when the screenshot job completes or fails. Clicking opens the local job view. Notifications contain no image content, OCR text or findings. Windows notification policy/Do not disturb may hide them. The local `last-notification.json` records the request, not proof of display. The tray must remain running to watch completion. Turning the mode off prevents new captures without cancelling existing work; quitting the tray stops watching and notifications. Captures, submission diagnostics and job reports stay on your machine until you remove them.

Use `malyn screenshots on|off|status` to control screenshot mode from the CLI.

**Ask Malyn** is an optional per-user Explorer action in Preferences. It uses a classic static shell verb, available under **Show more options** on Windows 11. The [Windows context-menu documentation](https://blogs.windows.com/blog/2021/07/19/extending-the-context-menu-and-share-dialog-in-windows-11/) explains the distinction from a modern packaged `IExplorerCommand` extension. No Explorer restart or machine-wide registry setting is needed. `malyn explorer on|off|status|sync` controls it; upgrades refresh owned registrations and removal disables only an unchanged owned entry.

The action passes the selected path as an argument to a hidden launcher, enforces one-file access and opens that job in the local UI. It does not silently queue when busy. Supported inputs and summary behaviour are described in the [Ask Malyn recipe](../recipes/ask-malyn.md). Reports render as plain text; embedded code and links are never executed by the report view.

Malyn 0.0.42 adds a Windows tray and one local web interface for settings and administration. The tray reads local control/job metadata and submits screenshot jobs when that mode is enabled. Inference runs in the local worker; opening the tray alone does not load a model or start a web server. Choose **Open Malyn** to start the admin server on a random `127.0.0.1` port and open your browser. The web server stops after two minutes without authenticated requests, normally after its browser tabs close. An open UI tab refreshes its state every eight seconds.

The installer starts the tray unless `-SkipDesktop` is supplied. Run `Open-Malyn.cmd` in the installation directory to reopen it. Sign-in startup is opt-in under Models & settings → Preferences. It creates a per-user Windows Run entry; no administrator privileges or Windows service are required.

```powershell
malyn tray
malyn ui
malyn pause
malyn resume
malyn ui-stop
malyn desktop-stop
malyn startup on
malyn startup off
```

All commands accept `--config PATH`. `malyn ui --no-open` starts the UI without launching a browser. It prints only the loopback origin; use `malyn ui` to open an authenticated browser session. There is no LAN bind, remote admin mode or user-supplied port in this release.

## Controls

- Overview: admission state, active jobs, configured model/context and an explicit hardware/runtime check. “Accepting tasks” does not assert that the GPU is connected or a model is loaded.
- Models & settings: select an installed local model, set context, KV cache, output/reasoning budgets and idle lifetime. Load the configured model or unload only Malyn's idle worker model. These actions are refused while a worker owns the job lock.
- Jobs & reports: the latest 50 jobs, status, local token/timing metrics, cancellation and opt-in report viewing. Reports render as plain text inside the local browser; the page never automatically fetches their contents.
- **Kitchen**: read bundled and imported recipes, choose a Markdown file to preview and import, and export any recipe for sharing. Importing adds it to the Kitchen without running it or replacing another recipe. Available in the `0.0.42+kitchen.1` preview.
- Advanced: allowed root directories, GPU/runtime patterns, integrated GPU preference, job timeout and prediction/tool-call limits. Runtime executable paths, model identifiers and backend selection cannot be edited through HTTP.

Pause blocks **new** submissions across the CLI and MCP in this version. It is persisted in `control.json`. An existing job continues until it finishes or you cancel it. Resume reopens admission. Quitting the tray or admin UI does not stop MCP or cancel jobs. Close the tray/admin UI before upgrading, and restart connected MCP clients after upgrading so they use the new code, including admission controls.

## Local session boundary

The server requires a random session bearer token on every API request, validates the literal Host and any Origin, rejects cross-site requests, sends no CORS permission, and serves a fixed list of bundled assets. The browser receives the token in a URL fragment, removes it from the address bar and retains it in that tab's session storage. Report downloads are restricted to registered artifacts in the chosen job directory; no arbitrary path reader or command executor is exposed.

The per-user configuration directory holds `admin-session.json`, `admin.lock`, tray metadata, the pause state and optional startup ownership record. The admin session token is removed on normal shutdown. Keep these files and logs private. Session credentials and configuration files rely on your normal profile-directory permissions; this is not a boundary against malicious processes running as the same OS user. There is no telemetry, hosted script, external font or cloud dependency in the UI. LM Studio remains a separate local runtime.

Model settings apply on the next load. Catalog and hardware refresh may start the LM Studio daemon. Closing the UI does not unload models; use **Unload worker model** or the configured model lifetime. Detailed reports retrieved by a cloud agent, or files already uploaded to cloud chat, can still enter that provider's context.
