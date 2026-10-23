function Invoke-Checked {
    param([string]$Exe, [string[]]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed (exit $LASTEXITCODE)." }
}
function Get-MalynHash {
    param([string]$Path, [ValidateSet('SHA256','SHA512')][string]$Algorithm = 'SHA256')
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','') }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
function Expand-MalynArchive {
    param([string]$Archive, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
}
function Test-MalynChildPath {
    param([string]$Path, [string]$Root)
    if (-not $Path -or -not [IO.Path]::IsPathRooted($Path)) { return $false }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    return [IO.Path]::GetFullPath($Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}
function Find-Lms {
    $lmHome = Join-Path $env:USERPROFILE '.lmstudio'
    $pointer = Join-Path $env:USERPROFILE '.lmstudio-home-pointer'
    if (Test-Path -LiteralPath $pointer) { $lmHome = (Get-Content -LiteralPath $pointer -Raw).Trim() }
    $candidate = Join-Path $lmHome 'bin\lms.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $command = Get-Command lms.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}
function Find-Codex {
    $command = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $base = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $base) {
        $candidate = Get-ChildItem -LiteralPath $base -Filter codex.exe -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    throw 'Codex CLI was not found. Install/sign in to Codex, or use -SkipRegister.'
}
function Read-LmsJson {
    param([string]$Exe, [string[]]$Arguments)
    $result = & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $($Arguments -join ' ')" }
    return (($result -join "`n") | ConvertFrom-Json)
}
