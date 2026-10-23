# Shareable Markdown loops

A loop is one `.md` file describing a repeatable task: when to use it, what inputs to collect, the local model requirements, the worker contract, expected artifact and checks. It is an instruction format, not an autonomous script engine. The supervising agent executes authorised collection steps; Malyn's local model reads the snapshot and writes reports.

Malyn ships with:

- [ask-malyn](../loops/ask-malyn.md): an enriched local summary with evidence and suggested next steps for one selected file.
- [windows-system-logs](../loops/windows-system-logs.md): a bounded read-only Windows collector, local event analysis and a report link.
- [describe-my-image](../loops/describe-my-image.md): local vision inference on explicitly supplied PNG/JPEG/WebP files, with a saved description.
- [transcribe-audio](../loops/transcribe-audio.md): GPU Whisper transcription of one bounded WAV file.
- [embed-local-files](../loops/embed-local-files.md): GPU Qwen embeddings for up to four text files/images.

An image attachment plus `@malyn` selects the image loop through the routing skill. The client must expose a local attachment path or support an authorised local download. This does not add an attachment API or change what the cloud chat already received.

## Format and sharing

Use a filename matching the loop's lowercase hyphenated name. Include one `malyn-loop` JSON metadata block and a `## Worker contract` section. Copy a bundled loop as a starting point. No extra package, executable or remote include is needed.

```malyn-loop
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

Declare `vision` when images are accepted. Ordinary loops use the default `agent` processor and require `tools` because the model must save the report. Optional `model.preferredModelKey` pins a preferred downloaded model key, and `model.minOutputTokens` sets a minimum generation allowance for the job without changing defaults. A caller may override the preferred model per job but cannot bypass capability or minimum-context checks. Metadata is checked with a strict schema; the complete file is limited to 64 KiB and the worker contract to 10,000 characters.

The fixed `processor: "whisper"` and `processor: "embeddings"` implementations use their declared component model and save the artifact directly. They do not interpret the worker contract as instructions to run code or change inference parameters. A conflicting model override fails. Copy the corresponding bundled loop for their required metadata and bounds. CLI `prepare` checks that component files are installed and valid; the actual GPU load occurs during the job.

Additional Markdown sections should explain the trigger, inputs, supervisor steps, acceptance checks and chat response. Only the `Worker contract` section and caller task are sent to the local model. The entire loop is available to the supervising agent. Installation copies the file without executing it. Review shared loop instructions before using them; they cannot grant permissions or override the user's request.

```powershell
malyn loops
malyn loop windows-system-logs
malyn loop install C:\loops\my-log-review.md
malyn submit --loop describe-my-image --root C:\inputs --image photo.png
```

User loops live in `loops/` beside the active configuration. Built-in loops live in the application package. Duplicate names are refused during installation, and manually placed user files cannot shadow bundled loops. A submitted job contains a snapshot of its contract, so later loop edits do not change that job.

## MCP controls

All operations use the `malyn` tool:

| Action | Parameters | Result |
| --- | --- | --- |
| `loops` | none | Loop metadata and model requirements |
| `loop` | `loop` | One complete Markdown loop |
| `install_loop` | `loop_file` (absolute path) | Validate/copy a shared `.md`; no execution |
| `models` | none | Installed local model keys, vision/tools flags and maximum context |
| `components` | none | Optional GPU component identities, capabilities and installation status |
| `configure` | `settings` | Persist supported defaults with a backup; refused during a job |
| `submit` | `root`, optional `loop`, `task`, `files`, `images`, `modelKey`, `returnMode` | Asynchronous job ID |
| `check` / `cancel` | `job_id` | Progress/result links or cancellation request |

Supported settings are `modelKey`, `contextLength`, `kvCacheQuantization`, `maxOutputTokens`, `reasoningBudget`, `maxPredictionRounds`, `maxToolCalls` and `ttlSeconds`. Executable paths, task roots and remote endpoints cannot be changed through this action. Configuring does not itself load a model. The next submission verifies requirements and loads it asynchronously; CLI `malyn prepare --loop NAME` can load without running inference.

Selection order: per-job model override, loop preference, compatible configured model, then a compatible installed local model. Explicit incompatible choices fail. The chosen context is at least the loop minimum, bounded by the model's advertised maximum. Hardware/VRAM compatibility is confirmed only by an actual load. A different worker model is unloaded only if idle; unrelated model identifiers are left alone. Loop choices do not rewrite configured defaults. There is no automatic model download, CPU fallback or remote-model fallback.

## Output and privacy

`returnMode: "links"` is the default. Job checks return a generic status sentence and local artifact paths, without generated summary text or raw job errors. The supervising skill returns that short note plus a clickable report link and does not automatically open the report. The generic note is produced from job state, not by asking a model to redact its own prose.

`returnMode: "summary"` explicitly opts into generated summary text. It is not a redaction feature. Detailed reports, `answer.txt`, job status and logs remain on disk; retrieving any of them into a frontier agent's context can disclose their contents. Returned paths and filenames also reach that agent. Inputs already uploaded to cloud chat have already crossed that boundary.

For loops, completion requires the named artifact as well as a successful model stop. Existence is not proof of correctness. When the user requests detailed review, validate source evidence and structured output before using findings or applying draft code. Keep system repairs separate from diagnostics.
