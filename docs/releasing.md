# Building and publishing

Build from a clean checkout on Windows x64 with Node 22+ and npm:

```powershell
npm ci --ignore-scripts
npm test
npm run licenses
npm run release:check
pwsh -NoProfile -File scripts/Build-Package.ps1
```

The build copies an explicit source allowlist to a fresh directory, installs production dependencies from the lockfile, validates the staged source, packs the npm tarball and builds a portable Windows ZIP. It downloads a pinned Node ZIP, verifies its SHA-256, and includes Node's license. It never includes LM Studio executables or model weights. Output is versioned under `dist/`; `SHA256SUMS` covers the three distribution files. Byte-identical ZIP reproducibility is not claimed: ZIP timestamps and compression can vary. The source file list and dependency lock are reproducible inputs.

The GitHub Actions workflow runs tests and builds downloadable workflow artifacts on a tag or manual dispatch. It does not publish to npm or create a public release. GPU smoke tests are manual because hosted runners do not have the target hardware.

Before publishing:

1. Use `synops-one/malyn` as the source repository. The 0.0.42 package is released as the `v0.0.42alphaz` GitHub prerelease. If you also publish to npm, confirm ownership and name availability first.
2. Verify the `repository`, `homepage`, issue and private security-reporting URLs. Verify rights to all contributions and retain license notices.
3. Before promoting beyond public preview, test the Windows ZIP on a fresh Windows account with the intended eGPU and driver. Test install, disconnect/reconnect, upgrade and removal. Record runtime and model versions. Fresh-machine installation and eGPU disconnect/reconnect remain unverified for this preview. A passing smoke test on your existing installation does not verify those flows.
4. Run the build from the release commit. Inspect the ZIP/tar file lists, checksums and example outputs. Review `npm audit --omit=dev` at release time and assess findings; a lockfile is not a perpetual vulnerability guarantee.
5. Create the GitHub release with archives and checksums. Publish the reviewed `.tgz` to npm only from the intended account. Do not publish the working directory directly.
6. For an MCP Registry listing, follow its [publishing guide](https://modelcontextprotocol.io/registry/quickstart), verify ownership of your namespace and add its `mcpName`. Publish the package before creating a registry listing. This repository does not include a registry identity.

You can load the root `plugin.json`, `mcp.json` and `skills/` using a compatible plugin host. Source/npm plugin installs require Node on PATH and dependencies installed. The Windows archive uses its bundled Node in `mcp.json`. Run setup before using either. The installer also provides direct `codex mcp add` registration for hosts using that route; do not enable both registrations at once.

License metadata covers Malyn and the bundled JavaScript dependencies. LM Studio, optional native processors and model weights have separate upstream terms. Explicit setup fetches them from upstream rather than redistributing them in Malyn archives. Review the pinned component sources and licenses in [components](components.md) when changing versions. Validate actual GPU execution and output quality for transcription and text/image embeddings, plus cancellation and cleanup. A general-purpose direct llama.cpp/SYCL backend can be added without changing the MCP tool contract.
