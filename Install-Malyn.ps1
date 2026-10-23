[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Malyn'),
    [ValidateSet('arc-b580','arc-b60','custom')][string]$Profile = 'arc-b580',
    [string]$ModelFile,
    [string]$ModelKey,
    [string]$GpuPattern,
    [ValidateRange(8192,262144)][int]$ContextLength = 65536,
    [ValidateSet('q8_0','q4_0','f16')][string]$KvCacheQuantization = 'q8_0',
    [ValidateRange(60,14400)][int]$JobTimeoutSeconds = 2700,
    [string]$MigrateFrom,
    [switch]$SkipRegister,
    [switch]$WithComponents,
    [switch]$WithExplorer,
    [switch]$SkipSmoke,
    [switch]$SkipDesktop
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
$source = $PSScriptRoot
$destination = [IO.Path]::GetFullPath($InstallDir)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$configFile = Join-Path $destination 'malyn.config.json'
$preset = if ($Profile -eq 'custom') { [pscustomobject]@{contextLength=16384;gpuPattern='Arc.*B580'} } else { Get-Content -LiteralPath (Join-Path $source ('profiles\' + $Profile + '.json')) -Raw | ConvertFrom-Json }
$config = @{ backend='lmstudio'; profile=$Profile; modelIdentifier='malyn-worker'; contextLength=$preset.contextLength; kvCacheQuantization=$KvCacheQuantization; jobTimeoutSeconds=$JobTimeoutSeconds; ttlSeconds=3600; gpuPattern=$preset.gpuPattern; runtimePattern='vulkan'; maxOutputTokens=2200; reasoningBudget=300; maxPredictionRounds=8; maxToolCalls=24; allowedRoots=@() }
$previousConfig = $configFile
$migrationRoot = $null
if ($MigrateFrom) {
    $migrationRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $MigrateFrom).Path).TrimEnd('\','/')
    if ($migrationRoot -eq $destination.TrimEnd('\','/')) { throw 'Migration requires a separate Malyn installation directory.' }
    if (Test-Path -LiteralPath $configFile) { throw 'Malyn is already configured here. Upgrade without -MigrateFrom to retain its settings.' }
    $previousConfig = Join-Path $migrationRoot 'malyn.config.json'
    if (-not (Test-Path -LiteralPath $previousConfig -PathType Leaf)) { throw 'The migration directory must contain malyn.config.json.' }
}
if (Test-Path -LiteralPath $previousConfig) {
    $previous = Get-Content -LiteralPath $previousConfig -Raw | ConvertFrom-Json
    foreach ($property in $previous.PSObject.Properties) { $config[$property.Name] = $property.Value }
    if (-not $PSBoundParameters.ContainsKey('ModelKey') -and -not $ModelFile -and -not $PSBoundParameters.ContainsKey('Profile')) { $ModelKey = $config.modelKey }
    if (-not $PSBoundParameters.ContainsKey('Profile')) { $Profile = $config.profile }
}
if ($PSBoundParameters.ContainsKey('Profile') -and $Profile -ne 'custom') {
    # An explicit hardware profile applies its GPU/context/model defaults. Ordinary upgrades preserve settings.
    $config.gpuPattern = $preset.gpuPattern
    $config.contextLength = $preset.contextLength
}
foreach ($pair in @(@('ContextLength','contextLength'),@('KvCacheQuantization','kvCacheQuantization'),@('JobTimeoutSeconds','jobTimeoutSeconds'),@('Profile','profile'))) {
    if ($PSBoundParameters.ContainsKey($pair[0])) { $config[$pair[1]] = $PSBoundParameters[$pair[0]] }
}
if ($GpuPattern) { $config.gpuPattern = $GpuPattern }
if ($Profile -eq 'custom' -and (-not $ModelKey -or (-not $GpuPattern -and -not (Test-Path -LiteralPath $previousConfig)))) { throw 'Custom setup requires -ModelKey and -GpuPattern for the first installation.' }
foreach ($installRoot in @($destination,$migrationRoot) | Where-Object { $_ }) {
    foreach ($desktopName in @('admin-session.json','tray-session.json')) {
        $desktopFile = Join-Path $installRoot $desktopName
        if (Test-Path -LiteralPath $desktopFile) {
            $desktop = Get-Content -LiteralPath $desktopFile -Raw | ConvertFrom-Json
            if ($desktop.pid -and (Get-Process -Id $desktop.pid -ErrorAction SilentlyContinue)) { throw 'Close the Malyn tray and admin UI before upgrading (Malyn.cmd desktop-stop). Jobs and MCP remain independent.' }
        }
    }
    foreach ($lockName in @('worker.lock','submission.lock')) {
        $lockFile = Join-Path $installRoot ('jobs\' + $lockName)
        if (Test-Path -LiteralPath $lockFile) {
            $lockState = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
            if (-not $lockState.pid -or (Get-Process -Id $lockState.pid -ErrorAction SilentlyContinue)) { throw "An active or unfinished worker submission exists at $lockFile. Finish or cancel its job before upgrading." }
        }
    }
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This package targets Windows x64.' }
if (-not $SkipRegister) { $codex = Find-Codex }
if (-not (Test-Path -LiteralPath (Join-Path $source 'node_modules\@lmstudio\sdk'))) { throw 'Dependencies are missing. Use the Windows ZIP, or run npm ci --ignore-scripts in the source checkout.' }
$version = (Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
$appDir = Join-Path $destination ('versions\' + $version + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
Write-Host "Malyn $version - installing to $destination"
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
foreach ($item in @('bin','src','loops','scripts','skills','profiles','examples','docs','LICENSES','node_modules','package.json','package-lock.json','npm-shrinkwrap.json','plugin.json','mcp.json','LICENSE','THIRD_PARTY_NOTICES.md','README.md','SECURITY.md','CHANGELOG.md')) {
    $from = Join-Path $source $item
    if (-not (Test-Path -LiteralPath $from)) { throw "Incomplete installer: missing $item" }
    Copy-Item -LiteralPath $from -Destination $appDir -Recurse -Force
}
$runtimeDir = Join-Path $appDir 'runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$node = Join-Path $runtimeDir 'node.exe'
$pins = Get-Content -LiteralPath (Join-Path $source 'scripts\prerequisites.json') -Raw | ConvertFrom-Json
$bundledNode = Join-Path $source 'runtime\node.exe'
if (Test-Path -LiteralPath $bundledNode) {
    Copy-Item -LiteralPath $bundledNode -Destination $node
    Copy-Item -LiteralPath (Join-Path $source 'runtime\NODE-LICENSE') -Destination $runtimeDir
} else {
    Write-Host 'Downloading and verifying the private Node runtime...'
    $archive = Join-Path $runtimeDir 'node.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $pins.node.url -OutFile $archive
    if ((Get-MalynHash $archive 'SHA256') -ne $pins.node.sha256) { throw 'Node archive checksum mismatch.' }
    Expand-MalynArchive $archive $runtimeDir
    $extracted = Join-Path $runtimeDir ('node-v' + $pins.node.version + '-win-x64')
    Copy-Item -LiteralPath (Join-Path $extracted 'node.exe') -Destination $node
    Copy-Item -LiteralPath (Join-Path $extracted 'LICENSE') -Destination (Join-Path $runtimeDir 'NODE-LICENSE')
}
Invoke-Checked $node @('--version')
$lms = Find-Lms
if (-not $lms) {
    Write-Host 'Downloading the official LM Studio headless runtime. Its upstream terms apply.'
    $bootstrap = Join-Path $runtimeDir 'llmster.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $pins.llmster.url -OutFile $bootstrap
    if ((Get-MalynHash $bootstrap 'SHA512') -ne $pins.llmster.sha512) { throw 'llmster archive checksum mismatch.' }
    $bootstrapDir = Join-Path $runtimeDir 'llmster-bootstrap'
    Expand-MalynArchive $bootstrap $bootstrapDir
    $previousFlag = $env:LMS_BOOTSTRAP_INSTALL_SH
    try {
        $env:LMS_BOOTSTRAP_INSTALL_SH = '1'
        Invoke-Checked (Join-Path $bootstrapDir 'llmster.exe') @('bootstrap')
    } finally {
        if ($null -eq $previousFlag) { Remove-Item Env:LMS_BOOTSTRAP_INSTALL_SH -ErrorAction SilentlyContinue }
        else { $env:LMS_BOOTSTRAP_INSTALL_SH = $previousFlag }
    }
    $lms = Find-Lms
    if (-not $lms) { throw 'LM Studio installation did not provide lms.exe.' }
}
$config.lmsPath = $lms
if ($Profile -eq 'arc-b580') { $env:GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM = '1' }
Invoke-Checked $lms @('daemon','up')
$survey = Read-LmsJson $lms @('runtime','survey','--refresh','--json')
$vulkan = @($survey.engines | Where-Object { $_.name -match 'vulkan' -and $_.compatibility.status -eq 'compatible' })
if ($vulkan.Count -eq 0) {
    Invoke-Checked $lms @('runtime','get','llama.cpp:vulkan','--yes')
    Invoke-Checked $lms @('runtime','select','llama.cpp-win-x86_64-vulkan-avx2','--latest')
}
if ($ModelFile) {
    $resolvedModel = (Resolve-Path -LiteralPath $ModelFile).Path
    Invoke-Checked $lms @('import',$resolvedModel,'--copy','--user-repo','malyn/imported-model','--yes')
}
$local = @(Read-LmsJson $lms @('ls','--json') | Where-Object { -not $_.deviceIdentifier -and $_.type -eq 'llm' })
if ($ModelKey) { $selected = $local | Where-Object { $_.modelKey -eq $ModelKey } | Select-Object -First 1 }
elseif ($ModelFile) { $selected = $local | Where-Object { $_.path -like 'malyn/imported-model/*' } | Select-Object -First 1 }
else {
    $preset = Get-Content -LiteralPath (Join-Path $source ('profiles\' + $Profile + '.json')) -Raw | ConvertFrom-Json
    $defaultModel = $preset.modelKey
    $defaultQuantization = if ($Profile -eq 'arc-b580') { 'Q4_0' } else { 'Q4_K_M' }
    $selected = $local | Where-Object { $_.modelKey -eq $defaultModel -and $_.quantization.name -eq $defaultQuantization } | Select-Object -First 1
    if (-not $selected) {
        $downloadSize = if ($Profile -eq 'arc-b580') { '7.2 GB' } else { '18 GB' }
        Write-Host "Downloading standard $defaultModel ${defaultQuantization}: approximately $downloadSize including vision support; additional runtime space is needed."
        Invoke-Checked $lms @('get',($defaultModel + '@' + $defaultQuantization.ToLowerInvariant()),'--gguf','--yes')
        $selected = Read-LmsJson $lms @('ls','--json') | Where-Object { -not $_.deviceIdentifier -and $_.modelKey -eq $defaultModel -and $_.quantization.name -eq $defaultQuantization } | Select-Object -First 1
    }
}
if (-not $selected) { throw 'The requested model is not installed locally. Run lms ls and pass its exact -ModelKey.' }
$config.modelKey = $selected.modelKey
$candidateConfig = Join-Path $destination ('candidate-' + [guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($candidateConfig, ($config | ConvertTo-Json -Depth 8), $utf8)
Invoke-Checked $node @((Join-Path $appDir 'bin\malyn.mjs'),'doctor','--config',$candidateConfig)
if ($WithComponents) {
    Write-Host 'Installing verified GPU components for local transcription and multimodal embeddings...'
    foreach ($component in @('whisper','embeddings')) {
        Invoke-Checked $node @((Join-Path $appDir 'bin\malyn.mjs'),'components','install',$component,'--config',$candidateConfig)
    }
}
if (-not $SkipSmoke) {
    $oldWorker = Read-LmsJson $lms @('ps','--json') | Where-Object { $_.identifier -eq $config.modelIdentifier } | Select-Object -First 1
    if ($oldWorker -and $oldWorker.modelKey -ne $config.modelKey) {
        if ($oldWorker.status -ne 'idle' -or $oldWorker.queued -gt 0) { throw 'The previous model is busy. Finish its work before changing models.' }
        Invoke-Checked $lms @('unload',$config.modelIdentifier)
    }
    Write-Host 'Verifying MCP discovery, local inference, file reading and artifact creation...'
    Invoke-Checked $node @((Join-Path $appDir 'scripts\smoke.mjs'),$candidateConfig)
}
if (Test-Path -LiteralPath $configFile) { Copy-Item -LiteralPath $configFile -Destination "$configFile.previous" -Force }
Move-Item -LiteralPath $candidateConfig -Destination $configFile -Force
$launcher = "@echo off`r`n`"$node`" `"$(Join-Path $appDir 'bin\malyn.mjs')`" --config `"$configFile`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $destination 'Malyn.cmd'), $launcher, $utf8)
$desktopLauncher = "@echo off`r`n`"$node`" `"$(Join-Path $appDir 'bin\malyn.mjs')`" --config `"$configFile`" tray`r`n"
[IO.File]::WriteAllText((Join-Path $destination 'Open-Malyn.cmd'), $desktopLauncher, $utf8)
Copy-Item -LiteralPath (Join-Path $source 'Remove-Malyn.ps1') -Destination $destination -Force
New-Item -ItemType Directory -Path (Join-Path $destination 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'scripts\windows-common.ps1') -Destination (Join-Path $destination 'scripts') -Force
$record = @{ version=$version; appDirectory=$appDir; configFile=$configFile; registered=$false }
if (-not $SkipRegister) {
    $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $backupDir = Join-Path $destination ('backups\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $codexConfig = Join-Path $codexDir 'config.toml'
    if (Test-Path -LiteralPath $codexConfig) { Copy-Item -LiteralPath $codexConfig -Destination $backupDir }
    if ($migrationRoot) { Copy-Item -LiteralPath $previousConfig -Destination $backupDir }
    $skillDir = Join-Path $codexDir 'skills'
    New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    $existingSkill = Join-Path $skillDir 'malyn-worker'
    if (Test-Path -LiteralPath $existingSkill) { Copy-Item -LiteralPath $existingSkill -Destination $backupDir -Recurse }
    $record.codexPath = $codex
    $record.registrationName = 'malyn'
    $record.registrationCommand = $node
    $record.skillDirectory = [IO.Path]::GetFullPath($existingSkill)
    $record.skillHash = Get-MalynHash (Join-Path $appDir 'skills\malyn-worker\SKILL.md') 'SHA256'
    Invoke-Checked $codex @('mcp','add','malyn','--',$node,(Join-Path $appDir 'bin\malyn.mjs'),'serve','--config',$configFile)
    $record.registered = $true
    # Keep a removal record even if copying the routing skill is interrupted.
    [IO.File]::WriteAllText((Join-Path $destination 'installation.json'), ($record | ConvertTo-Json), $utf8)
    Copy-Item -LiteralPath (Join-Path $appDir 'skills\malyn-worker') -Destination $skillDir -Recurse -Force
    if ($migrationRoot) { Write-Host "Copied Malyn settings. Historical jobs and original files remain at $migrationRoot. Backups: $backupDir" }
    Write-Host 'Registered malyn and installed its routing skill. Restart Codex.'
} elseif (Test-Path -LiteralPath (Join-Path $destination 'installation.json')) {
    # A skipped registration on upgrade must not forget a previous registration.
    $oldRecord = Get-Content -LiteralPath (Join-Path $destination 'installation.json') -Raw | ConvertFrom-Json
    foreach ($name in @('registered','codexPath','registrationName','registrationCommand','skillDirectory','skillHash')) {
        if ($oldRecord.PSObject.Properties[$name]) { $record[$name] = $oldRecord.$name }
    }
}
[IO.File]::WriteAllText((Join-Path $destination 'installation.json'), ($record | ConvertTo-Json), $utf8)
Invoke-Checked $node @((Join-Path $appDir 'bin\malyn.mjs'),'startup','sync','--config',$configFile)
$explorerAction = if ($WithExplorer) { 'on' } else { 'sync' }
Invoke-Checked $node @((Join-Path $appDir 'bin\malyn.mjs'),'explorer',$explorerAction,'--config',$configFile)
if (-not $SkipDesktop) { Invoke-Checked $node @((Join-Path $appDir 'bin\malyn.mjs'),'tray','--config',$configFile) }
Write-Host "Installed $($config.modelKey). CLI: $destination\Malyn.cmd. Results: $destination\jobs"
Write-Host 'Open-Malyn.cmd starts the tray. Open Malyn from its menu for local settings and admin. Sign-in startup is opt-in in Preferences.'
if ($SkipSmoke) { Write-Host 'Inference verification was skipped.' }
