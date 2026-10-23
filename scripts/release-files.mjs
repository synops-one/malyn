import fs from 'node:fs/promises';
import path from 'node:path';

export const sourceItems = [
  'bin', 'src', 'loops', 'skills', 'profiles', 'examples', 'docs', 'test', '.github', 'LICENSES',
  '.gitignore', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'plugin.json', 'mcp.json',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'Install-Malyn.cmd', 'Install-Malyn.ps1', 'Remove-Malyn.ps1',
  'scripts/Build-Package.ps1', 'scripts/windows-common.ps1', 'scripts/prerequisites.json',
  'scripts/smoke.mjs', 'scripts/context-smoke.mjs', 'scripts/licenses.mjs',
  'scripts/release-files.mjs', 'scripts/check-release.mjs', 'scripts/stage-source.mjs',
  'scripts/Malyn-Tray.ps1', 'scripts/Malyn-Startup.ps1',
  'scripts/Malyn-Explorer.ps1', 'scripts/Ask-Malyn.ps1',
];
export function forbidden(name) {
  if (name === 'examples/service.log') return false; // Named synthetic fixture, never a host log.
  return /(^|\/)(?:artifacts|jobs|captures|components|backups|runtime|node_modules|build|dist|\.git|\.codex|\.aws|\.ssh)(\/|$)/i.test(name)
    || /(^|\/)(?:[^/]+\.config\.json(?:\..*)?|candidate-[a-f0-9]+\.json|installation\.json|last-smoke\.json|\.env(?:\..*)?)$/i.test(name)
    || /(^|\/)(?:admin-session\.json|admin\.lock|tray-session\.json(?:\.tmp)?|tray-stop|tray-error\.txt|control\.json|startup-registration\.json|explorer-registration\.json|last-notification\.json)$/i.test(name)
    || /\.(?:gguf|log|pfx|p12|key|zip|tgz)$/i.test(name);
}
export async function sourceFiles(root) {
  const files = [];
  async function visit(relative) {
    if (forbidden(relative)) throw new Error(`Private/generated file in source allowlist: ${relative}`);
    const stat = await fs.lstat(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Release source must not contain links: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(path.join(root, relative))).sort()) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) files.push(relative);
  }
  for (const item of sourceItems) await visit(item);
  return files.sort();
}
