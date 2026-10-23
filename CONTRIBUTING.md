# Contributing

Use Node 22 or newer. Run `npm ci --ignore-scripts`, `npm test` and `npm run release:check`. Tests use fixtures and a fake runtime; a GPU is not needed. Windows is the supported platform for this release. Generic JavaScript tests on other hosts do not establish GPU compatibility there.

Keep local configuration, job data, models and credentials out of commits and fixtures. New model tools need explicit filesystem and execution boundaries. Retain truthful incomplete/cancelled states and concise MCP responses. Add a regression for behavioral fixes rather than asserting implementation text.

For runtime changes, run `node scripts/smoke.mjs PATH_TO_CONFIG` against an idle GPU and inspect the resulting artifact. Record model, quantization, context, runtime, GPU and whether the result was measured or estimated. Do not equate local tokens with cloud tokens saved.

See [release steps](docs/releasing.md) for building distributable artifacts. Contributions are provided under the repository's MIT license.
