param(
    [ValidateSet('Status','Enable','Disable','Sync')][string]$Action = 'Status',
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$CliPath,
    [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
$config = [IO.Path]::GetFullPath($ConfigPath)
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.ToLowerInvariant())))).Replace('-','').Substring(0,16).ToLowerInvariant() } finally { $hash.Dispose() }
$name = 'Malyn-' + $key
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$recordPath = Join-Path (Split-Path -Parent $config) 'startup-registration.json'
$current = (Get-ItemProperty -LiteralPath $registry -Name $name -ErrorAction SilentlyContinue).$name
$record = $null
if (Test-Path -LiteralPath $recordPath) { $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json }
$scriptPath = Join-Path $PSScriptRoot 'Malyn-Tray.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '"' + $powershell + '" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -NodePath "' + $NodePath + '" -CliPath "' + $CliPath + '" -ConfigPath "' + $config + '"'
if ($Action -ne 'Status') {
    if ($current -and $current -ne $command -and (-not $record -or $current -ne $record.command)) { throw 'The startup entry was changed outside Malyn; it was left intact.' }
    if ($Action -eq 'Enable' -or ($Action -eq 'Sync' -and $current)) {
        New-Item -Path $registry -Force | Out-Null
        New-ItemProperty -LiteralPath $registry -Name $name -PropertyType String -Value $command -Force | Out-Null
        [IO.File]::WriteAllText($recordPath,(@{name=$name;command=$command} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        $current = $command
    } elseif ($Action -eq 'Disable' -and $current) {
        Remove-ItemProperty -LiteralPath $registry -Name $name
        $current = $null
    }
}
@{supported=$true;startWithWindows=[bool]$current;managed=([bool]$current -and ($current -eq $command -or ($record -and $current -eq $record.command)))} | ConvertTo-Json -Compress
