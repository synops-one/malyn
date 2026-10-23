# Setup and command-line reference

For a quick introduction, start with the [Malyn README](../README.md). This guide covers installation options, client connections and CLI details.

## Windows installation

1. Download and extract [Malyn-0.0.68-Betaz-Windows-x64.zip](https://github.com/synops-one/malyn/releases/download/v0.0.68Betaz/Malyn-0.0.68-Betaz-Windows-x64.zip). Connect the GPU and install its vendor driver.
2. Run `Install-Malyn.cmd`. It starts `Install-Malyn.ps1`; command-line parameters are forwarded to that script.
3. Setup installs a private Node runtime, locates or downloads the LM Studio headless runtime, locates or downloads the model, performs a real file-to-artifact smoke test, and registers the MCP server and routing skill with Codex.
4. Restart Codex. Open Malyn from the new tray icon to review settings, then ask Codex to investigate a bounded set of files; the routing skill recommends Malyn when delegation is useful.

The default target is **Intel Arc B580 (12 GB), standard Gemma 4 12B QAT Q4_0, 64K context and Q8 KV cache, using LM Studio Vulkan on Windows**. The downloaded model with vision support is approximately 7.2 GB in decimal units; allow additional space for runtimes, archives, job data and future updates. Setup reuses your existing downloads and verifies real local inference before registering the worker. You can configure context up to the model/runtime limit; check memory usage before choosing a larger setting. Image inference, GPU Whisper transcription and multimodal embeddings have been tested on that B580 setup. Installation on a fresh machine has not yet been verified.

You can use the earlier B60 preset with `-Profile arc-b60`: standard Qwen3.8 27B Q4_K_M at 128K context. Ordinary upgrades keep your existing model/GPU settings. Pass `-Profile arc-b580` to switch to the B580 defaults; individual parameters still override them. You can configure other Vulkan GPUs/models, but they remain experimental.

```powershell
# Use an already downloaded model:
.\Install-Malyn.ps1 -ModelKey 'google/gemma-4-12b-qat'

# Switch an existing installation to the B580 defaults:
.\Install-Malyn.ps1 -Profile arc-b580

# Also download the GPU transcription and embedding components:
.\Install-Malyn.ps1 -Profile arc-b580 -WithComponents

# A different local model/GPU; select a context that fits your device:
.\Install-Malyn.ps1 -Profile custom -ModelKey 'your-local-model-key' -GpuPattern 'your GPU' -ContextLength 32768

# Install without changing Codex configuration:
.\Install-Malyn.ps1 -SkipRegister
```

The default installation directory is `%LOCALAPPDATA%\Malyn`. Launch `Malyn.cmd` there for CLI commands. Setup installs for your Windows account and does not install a GPU driver, reboot Windows or register a system service. Upgrades keep your configuration unless you override it, preserve previous app versions, and refuse to replace a running worker. Use `Remove-Malyn.ps1` to disconnect the registration and its unchanged routing skill. It keeps your models, runtimes, configuration and job results, and reports their locations.

To move your Malyn configuration to a new installation directory, use `Install-Malyn.ps1 -MigrateFrom 'C:\path\to\Malyn' -InstallDir 'D:\Apps\Malyn'`. Setup preserves your configured model and runtime settings, verifies the new app, and registers its new location. Your previous jobs stay in their original directory. See [moving and upgrading Malyn](migration.md).

To add Ask Malyn to Explorer during setup, pass `-WithExplorer`. You can also enable it later in Preferences.

## From source

Use Node 22+ and npm. LM Studio with a compatible runtime and downloaded model must already be installed for source setup.

```powershell
npm ci --ignore-scripts
node bin/malyn.mjs setup
node bin/malyn.mjs doctor
node scripts/smoke.mjs
node bin/malyn.mjs submit --root C:\src\project --file README.md --task "Read README.md. Save setup-review.md with up to five concrete setup issues and source line numbers."
node bin/malyn.mjs check JOB_ID
node bin/malyn.mjs cancel JOB_ID
node bin/malyn.mjs jobs
```

`--config PATH` or `MALYN_CONFIG` selects another configuration. `setup --profile custom --model KEY --gpu-pattern REGEX --context 32768` configures a custom profile. `setup --no-probe` only writes a config; it does not establish runtime compatibility. `doctor` checks hardware/runtime/model availability; only the smoke test or a successful job verifies inference.

For a manual Codex connection, use absolute paths:

```powershell
codex mcp add malyn -- node C:\src\malyn\bin\malyn.mjs serve
```

Copy `skills/malyn-worker` into your Codex skills directory for automatic routing guidance. Alternatively, load the root plugin metadata with a compatible plugin host after installing dependencies and running setup. Enable one registration route at a time. The portable plugin manifest follows the [Agent Plugins format](https://developers.openai.com/plugins/build/plugins); plugin installation still depends on the client. The Windows installer uses direct MCP registration.

The [Malyn skill](../skills/malyn-worker/SKILL.md) teaches Codex to choose useful work automatically and assemble a small task contract: objective, inputs, scope, output format, evidence and acceptance checks. It includes log-triage and code-draft examples, job supervision and result validation. The contract lives in the existing `task` argument; it does not require another service or protocol.

## MCP clients

Codex and Claude Code support local stdio MCP servers. The Windows installer registers Codex. To connect [Claude Code](https://code.claude.com/docs/en/mcp), use `claude mcp add --transport stdio malyn -- node C:\src\malyn\bin\malyn.mjs serve --config C:\path\malyn.config.json`. Use the installed private Node path if Node is not on PATH. Claude Code compatibility follows the standard MCP interface; a live Claude client has not been validated in this release. If you use another client, it needs local file/collection access to carry out the recipe's supervisor steps.

## Job controls and limits

The `malyn` MCP tool supports asynchronous `submit`, `check` and `cancel`, runtime `status`, recipe discovery/installation, local model listing and supported configuration changes. Submit a task or recipe name, an absolute root and optional relative files/images. It returns a job ID immediately. By default, checks return a generic note and artifact paths, keeping generated details local. Set `returnMode: "summary"` to opt into generated summary text. Only `completed` is a finished run; `failed`, `cancelled`, `interrupted` and `incomplete` need attention. One job runs per config directory.

Reads are bounded by paths, file size, tool-call count and a tokenizer-based context budget. Set `allowedRoots` to restrict the task roots your agent can choose. Common secret names and links are excluded, but this is not an OS sandbox or comprehensive secret scanner. Results and any artifacts your cloud agent reads may enter its cloud context. See [security boundaries](../SECURITY.md).

Local prompt/generated tokens and decode speed are reported per job. They are not measured cloud tokens or quota saved. Small tasks and repeated corrections can erase the benefit. See [measurement](measurement.md), [configuration](configuration.md) and [synthetic examples](../examples/README.md).

For reusable jobs and component model requirements, see [recipes](recipes.md) and [optional components](components.md). For build commands and package checks, see [releasing](releasing.md).
