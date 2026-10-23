# Changelog

## 0.0.42 — 0.0.42alphaz public preview

- Released package, plugin, MCP server and Windows archives as 0.0.42 under the GitHub prerelease tag `v0.0.42alphaz`. This includes the 0.0.41 desktop features below.
- Fixed opening the local admin page from a browser extension. Only top-level navigation to the public HTML shell is allowed; cross-site API and subresource requests, foreign origins and unauthenticated API access remain blocked.
- Added regression coverage for those navigation and request boundaries.
- Removed prototype branding and automatic prototype configuration/registration aliases. Use `-MigrateFrom` to relocate your existing Malyn configuration while keeping your custom model identifiers.
- Added public repository, download, demo and private vulnerability-reporting links. Release source excludes local configuration, jobs, captures, model weights and the original branding photograph.


## 0.0.41

- Added opt-in screenshot mode in the tray and Preferences: analyse new clipboard images locally, ignore pre-existing clipboard contents and notify when the report is ready. No timed screen capture or clipboard text history.
- Added optional **Ask Malyn** to Explorer's file context menu, with single-file access enforcement, an enriched summary loop and live local job progress. It uses the configured general model, Gemma 4 12B by default.
- Added GPU-based `transcribe-audio` and `embed-local-files` loops with on-demand Whisper Base and Qwen3-VL-Embedding-2B, pinned downloads, model checks and automatic component unloading. No CPU fallback.
- Added optional component discovery over MCP and in Preferences, CLI installation and the Windows installer's `-WithComponents` option.
- Applied the process-scoped Arc host-visible-memory workaround when starting runtimes for the B580 profile.
- Made Arc B580 the default hardware target with standard Gemma 4 12B QAT Q4_0, 64K context and Q8 KV cache. Preserved the optional B60 profile and existing upgrade settings.
- Added the Windows tray with status, pause/resume, settings launcher and optional sign-in startup.
- Added an on-demand, authenticated loopback admin UI for local model settings, jobs/reports, shared loops and advanced access/runtime limits.
- Added persistent admission controls shared by MCP and CLI, with settings changes serialized against job submission.
- Added the Malyn portrait and simplified branding; the original photograph is excluded.
- Bundled desktop launchers and ownership-aware startup/removal in the Windows installer. The desktop preview uses version 0.0.41; earlier development builds used 0.1.0 and 0.2.0.

## 0.2.0

- Established the Malyn CLI, MCP tool, plugin, skill, installers and release archives.
- Added Windows installation relocation with preserved model settings and original job history.
- Added automatic delegation guidance, task-contract assembly, worked examples, result validation and precise data-sharing boundaries to the Codex skill.
- Added shareable Markdown loops, including Windows system-log review and local image description, with declared model requirements.
- Added local model discovery and configuration over MCP, per-job model selection, and bounded image input.
- Default job responses contain a deterministic generic completion note and artifact links; detailed generated output stays local unless you request it.
- Added bounded configuration loading and private-directory exclusions.

## 0.1.0

- Windows-first local worker with a tested Arc Pro B60 / Qwen 27B profile and configurable experimental Vulkan GPU profiles.
- CLI setup, doctor, stdio MCP, submission, status, cancellation and job listing.
- Bounded text tools, artifact-only writes, optional allowed roots and tokenizer-based read budgets.
- Configurable generation limits using the SDK's `maxTokens` option; cancellation cannot become a successful result.
- Codex routing skill and portable plugin metadata.
- MIT source, dependency notices, clean source/npm/Windows packaging and SHA-256 manifests.
