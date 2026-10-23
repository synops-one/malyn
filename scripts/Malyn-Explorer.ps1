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
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entryPath = $sid + '\Software\Classes\*\shell\' + $name
$recordPath = Join-Path (Split-Path -Parent $config) 'explorer-registration.json'
$record = $null
if (Test-Path -LiteralPath $recordPath) { $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$askScript = Join-Path $PSScriptRoot 'Ask-Malyn.ps1'
$command = '"' + $powershell + '" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $askScript + '" -RegistrationPath "' + $recordPath + '" -InputPath "%1"'
# Use Windows' registry provider for both reads and writes. A host can expose a
# private registry view to child processes that Explorer itself cannot see.
# Address only the current user's Classes hive; never register for all users.
function Invoke-MalynRegistry([string]$Method,[string]$Path,[hashtable]$Values = @{}) {
    $arguments = @{hDefKey=[uint32]2147483651;sSubKeyName=$Path} + $Values
    $result = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName $Method -Arguments $arguments
    if ($result.ReturnValue -notin @(0,2)) { throw "Windows could not access Malyn's Explorer registration (code $($result.ReturnValue))." }
    return $result
}
function Read-MalynRegistryString([string]$Path,[string]$ValueName) {
    $result = Invoke-MalynRegistry 'GetStringValue' $Path @{sValueName=$ValueName}
    if ($result.ReturnValue -eq 0) { return $result.sValue }
    return $null
}
function Write-MalynRegistryString([string]$Path,[string]$ValueName,[string]$Value) {
    $result = Invoke-MalynRegistry 'SetStringValue' $Path @{sValueName=$ValueName;sValue=$Value}
    if ($result.ReturnValue -ne 0) { throw 'The Explorer registry key disappeared while updating it.' }
}
function Test-MalynNativeFile([string]$Path) {
    $escaped = [IO.Path]::GetFullPath($Path).Replace('\','\\').Replace("'","\'")
    return [bool](Get-CimInstance -ClassName CIM_DataFile -Filter ("Name='"+$escaped+"'"))
}
$owner = Read-MalynRegistryString $entryPath 'MalynConfig'
$current = Read-MalynRegistryString ($entryPath+'\command') ''
$changed = $false
    $managed = [bool]$current -and $owner -eq $config -and ($current -eq $command -or ($record -and $current -eq $record.command))
    if($Action -ne 'Status') {
        if(($current -or $owner) -and -not $managed){throw 'The Explorer entry was changed outside Malyn; it was left intact.'}
        if($Action -eq 'Enable' -or ($Action -eq 'Sync' -and $current)) {
            foreach ($target in @($NodePath,$CliPath,$config,$askScript)) {
                if (-not (Test-MalynNativeFile $target)) { throw 'Explorer cannot access this installation. Run Install-Malyn.cmd from your normal Windows session, then enable Ask Malyn again.' }
            }
            Invoke-MalynRegistry 'CreateKey' $entryPath | Out-Null
            Write-MalynRegistryString $entryPath '' 'Ask Malyn'
            Write-MalynRegistryString $entryPath 'MUIVerb' 'Ask Malyn'
            Write-MalynRegistryString $entryPath 'MultiSelectModel' 'Single'
            Write-MalynRegistryString $entryPath 'MalynConfig' $config
            [IO.File]::WriteAllText($recordPath,(@{name=$name;command=$command;nodePath=[IO.Path]::GetFullPath($NodePath);cliPath=[IO.Path]::GetFullPath($CliPath);configPath=$config} | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
            Invoke-MalynRegistry 'CreateKey' ($entryPath+'\command') | Out-Null
            Write-MalynRegistryString ($entryPath+'\command') '' $command
            if ((Read-MalynRegistryString ($entryPath+'\command') '') -ne $command) { throw 'Windows did not retain the Explorer command.' }
            $current=$command;$managed=$true;$changed=$true
        } elseif($Action -eq 'Disable' -and $current) {
            # Delete only this configuration's exact, ownership-checked verb.
            if($name -notmatch '^Malyn\.Ask\.[a-f0-9]{16}$'){throw 'Unexpected Explorer entry name.'}
            $children = Invoke-MalynRegistry 'EnumKey' $entryPath
            $commandChildren = Invoke-MalynRegistry 'EnumKey' ($entryPath+'\command')
            if (@($children.sNames | Where-Object { $_ -ne 'command' }).Count -or @($commandChildren.sNames | Where-Object { $_ }).Count) {
                throw 'The Explorer entry contains unexpected subkeys; it was left intact.'
            }
            Invoke-MalynRegistry 'DeleteKey' ($entryPath+'\command') | Out-Null
            Invoke-MalynRegistry 'DeleteKey' $entryPath | Out-Null
            $current=$null;$managed=$false;$changed=$true
        }
    }
if ($changed) {
    # Explorer caches file associations. Publish the change after registry writes finish.
    if (-not ('MalynExplorerNotifications' -as [type])) {
        Add-Type 'using System; using System.Runtime.InteropServices; public static class MalynExplorerNotifications { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2); }'
    }
    [MalynExplorerNotifications]::SHChangeNotify(0x08000000,0x1000,[IntPtr]::Zero,[IntPtr]::Zero)
}
$launcherReady = [bool]$managed
if ($launcherReady) {
    foreach ($target in @($NodePath,$CliPath,$config,$askScript,$recordPath)) {
        if (-not (Test-MalynNativeFile $target)) { $launcherReady=$false;break }
    }
}
@{supported=$true;askInExplorer=([bool]$current -and $launcherReady);registered=[bool]$current;managed=[bool]$managed;launcherReady=$launcherReady} | ConvertTo-Json -Compress
