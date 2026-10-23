# Moving and upgrading Malyn

For an ordinary upgrade, finish active work, close the tray/admin UI, extract the new Windows ZIP and run `Install-Malyn.cmd` against the existing installation. Settings are retained unless explicitly overridden. Restart Codex after setup.

To copy an existing Malyn configuration into a separate installation directory:

```powershell
.\Install-Malyn.ps1 -MigrateFrom 'C:\path\to\Malyn' -InstallDir 'D:\Apps\Malyn'
```

The source directory must contain `malyn.config.json`; the destination must not already contain a Malyn configuration. The installer refuses active workers in either location. It preserves explicit settings, including a custom loaded-model identifier, unless a setup parameter overrides them. Missing identifiers use `malyn-worker`.

The new app is verified before Codex registration is updated to its new location. Existing Codex configuration and the previous Malyn routing skill are backed up. `-SkipRegister` copies settings without changing the integration; update the client registration before using the new installation.

Original files, configuration, models and job history remain in place. New jobs are stored under the new installation. Do not run both configurations concurrently: their worker locks are separate. Do not run a removal script from the previous location without checking the registration it owns.

For source installs, `--config PATH` takes precedence over `MALYN_CONFIG`, then the normal per-user Malyn location. No prototype environment variable, configuration filename or registration alias is discovered automatically. For a configuration from another tool, manually review and map supported fields into a new `malyn.config.json`; model identifiers must be supplied explicitly when reusing a particular loaded model.

Backups and original files allow manual rollback. Restore a saved Codex configuration only after reviewing subsequent changes, or re-register the prior Malyn entry point explicitly.
