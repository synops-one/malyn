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
$name = 'Malyn.Ask.' + $key
$basePath = 'Software\Classes\*\shell'
$recordPath = Join-Path (Split-Path -Parent $config) 'explorer-registration.json'
$record = $null
if (Test-Path -LiteralPath $recordPath) { $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$askScript = Join-Path $PSScriptRoot 'Ask-Malyn.ps1'
$command = '"' + $powershell + '" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $askScript + '" -NodePath "' + $NodePath + '" -CliPath "' + $CliPath + '" -ConfigPath "' + $config + '" -InputPath "%1"'
$parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($basePath,$true)
$entry = $null; $commandKey = $null; $current = $null; $owner = $null
try {
    if ($parent) { $entry=$parent.OpenSubKey($name); if($entry) { $owner=$entry.GetValue('MalynConfig'); $commandKey=$entry.OpenSubKey('command'); if($commandKey){$current=$commandKey.GetValue('')} } }
    if($commandKey){$commandKey.Dispose();$commandKey=$null}; if($entry){$entry.Dispose();$entry=$null}
    $managed = [bool]$current -and $owner -eq $config -and ($current -eq $command -or ($record -and $current -eq $record.command))
    if($Action -ne 'Status') {
        if(($current -or $owner) -and -not $managed){throw 'The Explorer entry was changed outside Malyn; it was left intact.'}
        if($Action -eq 'Enable' -or ($Action -eq 'Sync' -and $current)) {
            if(-not $parent){$parent=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($basePath)}
            $entry=$parent.CreateSubKey($name);$entry.SetValue('','Ask Malyn');$entry.SetValue('MultiSelectModel','Single');$entry.SetValue('MalynConfig',$config)
            $commandKey=$entry.CreateSubKey('command');$commandKey.SetValue('',$command)
            [IO.File]::WriteAllText($recordPath,(@{name=$name;command=$command} | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
            $current=$command;$managed=$true
        } elseif($Action -eq 'Disable' -and $current) {
            # Delete only this configuration's exact, ownership-checked verb.
            if($name -notmatch '^Malyn\.Ask\.[a-f0-9]{16}$'){throw 'Unexpected Explorer entry name.'}
            $parent.DeleteSubKeyTree($name);$current=$null;$managed=$false
        }
    }
    @{supported=$true;askInExplorer=[bool]$current;managed=[bool]$managed} | ConvertTo-Json -Compress
} finally {if($commandKey){$commandKey.Dispose()};if($entry){$entry.Dispose()};if($parent){$parent.Dispose()}}
