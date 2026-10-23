param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$CliPath,
    [Parameter(Mandatory=$true)][string]$ConfigPath,
    [Parameter(Mandatory=$true)][string]$InputPath
)
$ErrorActionPreference = 'Stop'
try {
    # Pass filenames as arguments; never evaluate them as PowerShell or cmd source.
    $result = & $NodePath $CliPath ask $InputPath --config $ConfigPath 2>&1
    if($LASTEXITCODE -ne 0){throw ($result -join "`n")}
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Ask Malyn',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}
