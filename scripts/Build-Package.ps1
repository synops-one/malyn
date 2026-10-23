[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$project = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
$nodeCommand = Get-Command node -ErrorAction Stop
$node = $nodeCommand.Source
$pins = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'prerequisites.json') -Raw | ConvertFrom-Json
$build = Join-Path $project 'build'
$dist = Join-Path $project 'dist'
New-Item -ItemType Directory -Path $build,$dist -Force | Out-Null
$archive = Join-Path $build ('node-v' + $pins.node.version + '-win-x64.zip')
if (-not (Test-Path -LiteralPath $archive)) {
    $cached = Join-Path $build 'node.zip'
    if ((Test-Path -LiteralPath $cached) -and (Get-FileHash -LiteralPath $cached -Algorithm SHA256).Hash -eq $pins.node.sha256) {
        Copy-Item -LiteralPath $cached -Destination $archive
    } else { Invoke-WebRequest -UseBasicParsing -Uri $pins.node.url -OutFile $archive }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $pins.node.sha256) { throw 'Node archive checksum mismatch.' }
$stage = Join-Path $build ('release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$nodeStage = Join-Path $stage 'node'
Expand-Archive -LiteralPath $archive -DestinationPath $nodeStage
$nodeRelease = Join-Path $nodeStage ('node-v' + $pins.node.version + '-win-x64')
$releaseNode = Join-Path $nodeRelease 'node.exe'
$npm = Join-Path $nodeRelease 'node_modules\npm\bin\npm-cli.js'
# Generate legal notices from installed, locked dependencies before staging.
Invoke-Checked $node @((Join-Path $PSScriptRoot 'licenses.mjs'))
Invoke-Checked $node @((Join-Path $PSScriptRoot 'check-release.mjs'))
$source = Join-Path $stage "Malyn-$version-source"
Invoke-Checked $node @((Join-Path $PSScriptRoot 'stage-source.mjs'),$source)
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Write-Zip {
    param([string]$Directory,[string]$Target)
    # Only replace the explicitly named output file inside this project's dist directory.
    $resolvedTarget = [IO.Path]::GetFullPath($Target)
    if ((Split-Path -Parent $resolvedTarget) -ne [IO.Path]::GetFullPath($dist)) { throw 'Archive target is outside dist.' }
    if (Test-Path -LiteralPath $resolvedTarget) { Remove-Item -LiteralPath $resolvedTarget }
    [IO.Compression.ZipFile]::CreateFromDirectory($Directory,$resolvedTarget,[IO.Compression.CompressionLevel]::Optimal,$true)
}
$sourceZip = Join-Path $dist "Malyn-$version-source.zip"
Write-Zip $source $sourceZip
Push-Location $source
try {
    Invoke-Checked $releaseNode @($npm,'ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund')
    Invoke-Checked $releaseNode @('scripts/check-release.mjs')
    $packText = & $releaseNode $npm pack --ignore-scripts --json --pack-destination $dist
    if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
    $packed = @(($packText -join "`n") | ConvertFrom-Json)[0]
    foreach ($required in @('bin/malyn.mjs','src/worker.mjs','src/ask.mjs','src/components.mjs','src/component-worker.mjs','src/ui/index.html','src/ui/logo.png','src/ui/tray.png','src/desktop.mjs','scripts/Malyn-Tray.ps1','scripts/Malyn-Startup.ps1','scripts/Ask-Malyn.ps1','scripts/Malyn-Explorer.ps1','profiles/arc-b580.json','profiles/components.json','loops/ask-malyn.md','loops/describe-my-image.md','loops/windows-system-logs.md','loops/transcribe-audio.md','loops/embed-local-files.md','npm-shrinkwrap.json','LICENSE','plugin.json','mcp.json')) {
        if ($required -notin $packed.files.path) { throw "npm package is missing $required" }
    }
    Write-Host "Packed $($packed.filename): $($packed.files.Count) files."
} finally { Pop-Location }
$portable = Join-Path $stage "Malyn-$version-Windows-x64"
New-Item -ItemType Directory -Path $portable | Out-Null
foreach ($item in @('bin','src','loops','scripts','skills','profiles','examples','docs','LICENSES','node_modules','package.json','package-lock.json','npm-shrinkwrap.json','plugin.json','mcp.json','LICENSE','THIRD_PARTY_NOTICES.md','README.md','SECURITY.md','CHANGELOG.md','Install-Malyn.cmd','Install-Malyn.ps1','Remove-Malyn.ps1')) {
    Copy-Item -LiteralPath (Join-Path $source $item) -Destination $portable -Recurse
}
$runtime = Join-Path $portable 'runtime'
New-Item -ItemType Directory -Path $runtime | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeRelease 'node.exe') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $nodeRelease 'LICENSE') -Destination (Join-Path $runtime 'NODE-LICENSE')
$manifestFile = Join-Path $portable 'mcp.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$manifest.mcpServers.malyn.command = '${PLUGIN_ROOT}/runtime/node.exe'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestFile -Encoding utf8
$windowsZip = Join-Path $dist "Malyn-$version-Windows-x64.zip"
Write-Zip $portable $windowsZip
$tarball = Join-Path $dist "malyn-local-worker-$version.tgz"
$lines = @($sourceZip,$windowsZip,$tarball) | ForEach-Object { ((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLower() + '  ' + (Split-Path -Leaf $_)) }
[IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Built release $version in $dist"
Write-Host "Staging directory: $stage"
$lines
