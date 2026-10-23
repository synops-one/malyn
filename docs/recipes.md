# Shareable Markdown recipes

A recipe is one `.md` file describing a repeatable task: when to use it, what inputs to collect, the local model requirements, the worker contract, expected artifact and checks. It is an instruction format, not an autonomous script engine. The supervising agent executes authorised collection steps; Malyn's local model reads the snapshot and writes reports.

Malyn ships with:

- [ask-malyn](../recipes/ask-malyn.md): an enriched local summary with evidence and suggested next steps for one selected file.
- [windows-system-logs](../recipes/windows-system-logs.md): a bounded read-only Windows collector, local event analysis and a report link.
- [describe-my-image](../recipes/describe-my-image.md): local vision inference on explicitly supplied PNG/JPEG/WebP files, with a saved description.
- [transcribe-audio](../recipes/transcribe-audio.md): GPU Whisper transcription of one bounded WAV file.
- [embed-local-files](../recipes/embed-local-files.md): GPU Qwen embeddings for up to four text files/images.

An image attachment plus `@malyn` selects the image recipe through the routing skill. Your client must expose a local attachment path or support an authorised local download. This does not add an attachment API or change what the cloud chat already received.

## Format and sharing

Use a filename matching the recipe's lowercase hyphenated name. Include one `malyn-recipe` JSON metadata block and a `## Worker contract` section. Copy a bundled recipe as a starting point. No extra package, executable or remote include is needed.

```malyn-recipe
{
  "schemaVersion": 1,
  "name": "my-log-review",
  "description": "Review a scoped text snapshot and save a report.",
  "platforms": ["win32", "linux", "darwin"],
  "model": {
    "capabilities": ["text", "tools"],
    "minContextLength": 32768
  },
  "images": { "min": 0, "max": 0 },
  "output": { "artifact": "review.md" }
}
```

Declare `vision` when images are accepted. Ordinary recipes use the default `agent` processor and require `tools` because the model must save the report. Optional `model.preferredModelKey` pins a preferred downloaded model key, and `model.minOutputTokens` sets a minimum generation allowance for the job without changing defaults. You can override the preferred model per job, but you cannot bypass capability or minimum-context checks. Metadata is checked with a strict schema; the complete file is limited to 64 KiB and the worker contract to 10,000 characters.

The fixed `processor: "whisper"` and `processor: "embeddings"` implementations use their declared component model and save the artifact directly. They do not interpret the worker contract as instructions to run code or change inference parameters. A conflicting model override fails. Copy the corresponding bundled recipe for their required metadata and bounds. CLI `prepare` checks that component files are installed and valid; the actual GPU load occurs during the job.

Additional Markdown sections should explain the trigger, inputs, supervisor steps, acceptance checks and chat response. Only the `Worker contract` section and caller task are sent to the local model. The entire recipe is available to the supervising agent. Installation copies the file without executing it. Review shared recipe instructions before using them; they cannot grant permissions or override your request.

```powershell
malyn recipes
malyn recipe windows-system-logs
malyn recipe import C:\recipes\my-log-review.md
malyn recipe export windows-system-logs C:\recipes\windows-system-logs.md
malyn submit --recipe describe-my-image --root C:\inputs --image photo.png
```

Open **Kitchen** in Malyn to choose a `.md` file, read its contents and import it. Use **Export recipe** on any card to save a shareable copy through your browser. The export contains only that recipe’s Markdown, including its instructions and model requirements; it does not attach your jobs, source files or settings. Review any private details you wrote into your own recipe before sharing it.

Old `malyn-loop` metadata and user `loops/` folders remain readable. Imports and exports use the `malyn-recipe` format. CLI `loops`, `loop`, `loop install` and `--loop`, plus MCP `loops`, `loop` and `install_loop`, remain compatibility aliases. New integrations should use the recipe names below. Passing conflicting `recipe` and `loop` values is rejected.

Your installed recipes live in `recipes/` beside the active configuration. Built-in recipes live in the application package. Duplicate names are refused during installation, and manually placed files cannot shadow bundled recipes. A submitted job contains a snapshot of its contract, so later recipe edits do not change that job.

## MCP controls

All operations use the `malyn` tool:

| Action | Parameters | Result |
| --- | --- | --- |
| `recipes` | none | Recipe metadata and model requirements |
| `recipe` | `recipe` | One complete Markdown recipe |
| `export_recipe` | `recipe` | Shareable filename and Markdown; the agent can save the returned text |
| `import_recipe` | `recipe_file` (absolute path) | Validate/copy a shared `.md`; no execution |
| `models` | none | Installed local model keys, vision/tools flags and maximum context |
| `components` | none | Optional GPU component identities, capabilities and installation status |
| `configure` | `settings` | Persist supported defaults with a backup; refused during a job |
| `submit` | `root`, optional `recipe`, `task`, `files`, `images`, `modelKey`, `returnMode` | Asynchronous job ID |
| `check` / `cancel` | `job_id` | Progress/result links or cancellation request |

Supported settings are `modelKey`, `contextLength`, `kvCacheQuantization`, `maxOutputTokens`, `reasoningBudget`, `maxPredictionRounds`, `maxToolCalls` and `ttlSeconds`. Executable paths, task roots and remote endpoints cannot be changed through this action. Configuring does not itself load a model. The next submission verifies requirements and loads it asynchronously; CLI `malyn prepare --recipe NAME` can load without running inference.

Selection order: per-job model override, recipe preference, compatible configured model, then a compatible installed local model. Explicit incompatible choices fail. The chosen context is at least the recipe minimum, bounded by the model's advertised maximum. Hardware/VRAM compatibility is confirmed only by an actual load. A different worker model is unloaded only if idle; unrelated model identifiers are left alone. Recipe choices do not rewrite configured defaults. There is no automatic model download, CPU fallback or remote-model fallback.

## Output and privacy

`returnMode: "links"` is the default. Job checks return a generic status sentence and local artifact paths, without generated summary text or raw job errors. The supervising skill returns that short note plus a clickable report link and does not automatically open the report. The generic note is produced from job state, not by asking a model to redact its own prose.

`returnMode: "summary"` explicitly opts into generated summary text. It is not a redaction feature. Detailed reports, `answer.txt`, job status and logs remain on disk; retrieving any of them into a frontier agent's context can disclose their contents. Returned paths and filenames also reach that agent. Inputs already uploaded to cloud chat have already crossed that boundary.

For recipes, completion requires the named artifact as well as a successful model stop. Existence is not proof of correctness. When you need a detailed review, validate source evidence and structured output before using findings or applying draft code. Keep system repairs separate from diagnostics.
