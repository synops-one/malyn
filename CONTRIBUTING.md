# Contributing

Use Node 22 or newer. Run `npm ci --ignore-scripts`, `npm test` and `npm run release:check`. Tests use fixtures and a fake runtime, so you don't need a GPU to run them. Windows is the supported platform for this release. Passing JavaScript tests on another platform does not establish GPU compatibility there.

Keep your local configuration, job data, models and credentials out of commits and fixtures. When you add a model tool, define its filesystem and execution boundaries. Keep incomplete/cancelled states accurate and MCP responses concise. When you fix a bug, add a regression test that checks the behaviour.

For runtime changes, run `node scripts/smoke.mjs PATH_TO_CONFIG` against an idle GPU and inspect the resulting artifact. Record model, quantization, context, runtime, GPU and whether the result was measured or estimated. Do not equate local tokens with cloud tokens saved.

See [release steps](docs/releasing.md) to build distributable artifacts. Your contributions are covered by the repository's MIT license.
