# Measuring useful work

Compare a bounded real task both with and without delegation, using the same files, desired output and verification standard. Report wall time, successful task completion and supervisor token usage where the host exposes it. Include delegation instructions, checks, result inspection and corrections in the supervised run. Repeated runs are needed before claiming a reliable saving.

Malyn reports local prompt tokens (summed over rounds, so repeated context is counted), generated tokens, peak prompt tokens, tokenizer-counted file-read tokens, tool calls, elapsed time and the last prediction's decode tokens/second. These values describe local inference. They do not measure OpenAI subscription quota or prove a reduction in billed tokens.

For throughput comparisons, hold model weights/hash, quantization, prompt, output length, context, KV format, runtime and hardware topology constant. Separate prompt processing from generation. The reported last decode speed is not whole-job throughput. No SYCL-versus-Vulkan speed claim is part of this release.

Useful jobs have a small brief, substantial targeted local reading, and a short result or saved draft. Trivial requests and jobs that need repeated correction can cost more supervisor time and tokens than doing them directly.
