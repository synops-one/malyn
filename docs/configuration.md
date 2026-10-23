# Configuration

`malyn setup` writes `%LOCALAPPDATA%\Malyn\malyn.config.json` on Windows. `--config PATH` overrides `MALYN_CONFIG`, then the default. Linux/macOS paths are implemented for development; those platforms are not validated release targets.

The installer stores configuration beside its private runtime. `Malyn.cmd` always uses that configuration. Setup refuses to overwrite an existing file unless `--force` is supplied, in which case it saves `.previous`. The Windows installer preserves existing settings unless you explicitly pass a replacement parameter.

| Field | Default | Purpose |
| --- | --- | --- |
| `lmsPath`, `modelKey` | Required | Local executable and downloaded model key; use `lms ls --json` |
| `modelIdentifier` | `malyn-worker` for new setup | Dedicated loaded-model identifier; migrated configs retain the old identifier to reuse the loaded model |
| `gpuPattern` | `Arc.*B580` | Case-insensitive device-name regex |
| `runtimePattern` | `vulkan` | Compatible engine to inspect |
| `allowIntegratedGpu` | `false` | Explicit experimental opt-in |
| `contextLength` | `65536` | Loaded context; the model and VRAM must support it |
| `kvCacheQuantization` | `q8_0` | `q8_0`, `q4_0` or `f16` |
| `maxOutputTokens` | `2200` | Output-token ceiling per prediction, including thinking |
| `reasoningBudget` | `300` | Must not exceed output ceiling; support varies by model/runtime |
| `maxPredictionRounds` | `8` | Maximum predictions in one job |
| `maxToolCalls` | `24` | Maximum local file/artifact calls |
| `maxReadTokens` | Context-derived | Optional cumulative read ceiling, including tool framing |
| `jobTimeoutSeconds` | `2700` | Cooperative wall-clock cancellation |
| `ttlSeconds` | `3600` | Loaded-model idle lifetime |
| `allowedRoots` | `[]` | Absolute directories under which task roots may be submitted; empty means any caller-selected root |

The default B580 profile uses standard Gemma 4 12B QAT Q4_0 and a 64K context with Q8 KV cache. The B60 profile retains Qwen3.8 27B Q4_K_M at 128K. Custom profiles start at 16K so users can tune their own hardware; these presets are not product-wide context limits. Model keys are local library identifiers, not immutable weight revisions. Record the weight hash when comparing results.

The Windows installer preserves settings during an ordinary upgrade. Explicit `-Profile arc-b580` or `-Profile arc-b60` applies that profile's model, GPU and context defaults; explicit `-ModelKey`, `-GpuPattern` and `-ContextLength` take precedence. CLI `setup` still requires `--force` to replace an existing configuration.

GPU selection excludes other devices during a new load. Malyn inspects Vulkan but does not change the user's global runtime selection. Select a compatible LM Studio Vulkan runtime before running jobs. No automatic CPU or remote-machine fallback is enabled. Close or unload unrelated models if VRAM is exhausted.

One job runs at a time per config directory. Share a single config across clients using one GPU. Separate config directories do not coordinate GPU memory. `jobs/` contains locks, per-job request/status/log files and output artifacts. Checking and cancelling jobs does not require a working GPU or readable configuration. If a worker was killed, a check reports `interrupted`; a later submission can reclaim its stale worker lock. If a submitting client dies during the short startup transaction, stop submitting clients and remove the reported `jobs/submission.lock` before retrying. Malyn does not automatically steal that transaction lock because two recovery attempts could otherwise admit concurrent workers.
