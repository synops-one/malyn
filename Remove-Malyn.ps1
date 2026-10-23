[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
$recordFile = Join-Path $PSScriptRoot 'installation.json'
if (-not (Test-Path -LiteralPath $recordFile)) { throw 'No installation record here. Run the removal script from the installed Malyn folder.' }
$record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
$desktopCli = Join-Path $record.appDirectory 'bin\malyn.mjs'
$desktopNode = Join-Path $record.appDirectory 'runtime\node.exe'
if (Test-Path -LiteralPath (Join-Path $record.appDirectory 'src\desktop.mjs')) {
    Invoke-Checked $desktopNode @($desktopCli,'startup','off','--config',$record.configFile)
    if(Test-Path -LiteralPath (Join-Path $record.appDirectory 'scripts\Malyn-Explorer.ps1')) { Invoke-Checked $desktopNode @($desktopCli,'explorer','off','--config',$record.configFile) }
    Invoke-Checked $desktopNode @($desktopCli,'desktop-stop','--config',$record.configFile)
}
if ($record.registered) {
    $codex = if (Test-Path -LiteralPath $record.codexPath) { $record.codexPath } else { Find-Codex }
    $registration = Read-LmsJson $codex @('mcp','get',$record.registrationName,'--json')
    $expectedNode = [IO.Path]::GetFullPath($record.registrationCommand)
    if ([IO.Path]::GetFullPath($registration.transport.command) -ne $expectedNode) { throw 'The MCP registration now points to another installation; it was left intact.' }
    Invoke-Checked $codex @('mcp','remove',$record.registrationName)
    $skill = [IO.Path]::GetFullPath($record.skillDirectory)
    $skillFile = Join-Path $skill 'SKILL.md'
    if ((Test-Path -LiteralPath $skillFile) -and (Get-MalynHash $skillFile 'SHA256') -eq $record.skillHash -and @(Get-ChildItem -LiteralPath $skill -Force).Count -eq 1) {
        # Validate the exact recorded directory before moving it; never enumerate paths into another shell.
        if ((Split-Path -Leaf $skill) -ne 'malyn-worker' -or (Get-Item -LiteralPath $skill).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected skill directory; it was left intact.' }
        $backup = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('disabled-skill-' + [guid]::NewGuid().ToString('N'))))
        if ((Split-Path -Parent $backup) -ne [IO.Path]::GetFullPath($PSScriptRoot)) { throw 'Unexpected backup path.' }
        Move-Item -LiteralPath $skill -Destination $backup
    } else { Write-Host 'The routing skill was changed or is missing; it was left intact.' }
    $record.registered = $false
    $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding utf8
}
Write-Host "Malyn disconnected. Restart Codex. Files, Node runtime, configuration and jobs remain at $PSScriptRoot. LM Studio and model downloads remain in the LM Studio library."
