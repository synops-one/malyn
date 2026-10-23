# Optional GPU components

The Windows x64 package includes the recipes and integration code. Download their native runtimes and weights explicitly, either with `Install-Malyn.ps1 -WithComponents` or:

```powershell
Malyn.cmd components install whisper
Malyn.cmd components install embeddings
Malyn.cmd components
```

If you installed from source, use `node bin/malyn.mjs` instead of `Malyn.cmd`. Pass `--config PATH` to target another installation. Preferences and MCP `action: "components"` show installation status. Downloads happen during setup, never as an implicit result of submitting a recipe. Allow several GB for weights, runtime archives and extraction. Files live in `components/` beside the configuration and are retained on upgrade/removal. If a release changes a component pin, rename its old component directory before reinstalling; stale builds are rejected.

## GPU use and lifetime

Both processors select the GPU matching your Malyn configuration. If that device is unavailable, the job fails; there is no CPU or remote fallback. Each unloads Malyn's own idle general model before starting and releases its native process on completion. Unrelated loaded models are left alone and can still consume VRAM. The next general task reloads Gemma. One job is admitted per configuration; separate installations do not coordinate GPU access.

The B580 profile applies `GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM=1` to newly started runtime processes. This is process-scoped, not a global Windows setting. An already running LM Studio GUI/daemon keeps its original environment. If needed, close it while idle and launch it from a PowerShell session with `$env:GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM='1'` before loading the model. Changing GPU enclosures also warrants `lms runtime survey --refresh --json` before loading. Do not enable this workaround globally for unrelated CPU workloads.

## Transcribe audio

```powershell
Malyn.cmd submit --recipe transcribe-audio --root C:\audio --file recording.wav
```

Whisper Base accepts one mono 16 kHz, 16-bit PCM WAV, at most ten minutes and 20 MiB. Convert other formats locally first. Automatic language detection is used. The result is a draft transcript, not a diarized meeting record, microphone assistant or spoken reply. Check important wording against the recording. The default response contains a generic completion note and a link to `transcript.md`.

## Embed text and images

```powershell
Malyn.cmd submit --recipe embed-local-files --root C:\inputs --file note.txt --image photo.png
```

Qwen3-VL-Embedding-2B Q4_K_M with a Q8 vision projector accepts one to four combined text files/images. Each UTF-8 text file is limited to 16,000 bytes; supported images are PNG/JPEG/WebP up to 10 MiB each. The component uses an 8,192-token context and last-token pooling with Qwen's retrieval instruction. The result is `embeddings.json`: source names and finite, L2-normalized 2,048-dimensional vectors. It supplies the building blocks for local similarity search; it does not create an index or support video in this release. Compare vectors made with the same model, quantization and prompting configuration.

## Pinned upstream sources and licenses

Exact asset URLs, revisions and SHA-256 values are in [profiles/components.json](../profiles/components.json). Download verification confirms those bytes, not independent code auditing or publisher signing.

| Component | Source | License/terms |
| --- | --- | --- |
| Whisper Windows Vulkan runtime | [jonasthilo/whisper.cpp v1.8.5](https://github.com/jonasthilo/whisper.cpp/releases/tag/v1.8.5), community build of [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | [MIT](https://github.com/jonasthilo/whisper.cpp/blob/v1.8.5/LICENSE) |
| Whisper Base weights | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), converted from [OpenAI Whisper](https://github.com/openai/whisper) | [MIT](https://github.com/openai/whisper/blob/main/LICENSE) |
| Embedding runtime | [llama.cpp b11808 Vulkan](https://github.com/ggml-org/llama.cpp/releases/tag/b11808) | [MIT](https://github.com/ggml-org/llama.cpp/blob/b11808/LICENSE) |
| Embedding weights/projector | [mradermacher GGUF conversion](https://huggingface.co/mradermacher/Qwen3-VL-Embedding-2B-GGUF) of [Qwen/Qwen3-VL-Embedding-2B](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B) | [Apache-2.0](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B/blob/main/LICENSE) |

These downloads are separate from the Malyn release archives. Preserve upstream notices when redistributing modified packages or preloaded model installations.
