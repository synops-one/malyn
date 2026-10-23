[CmdletBinding(DefaultParameterSetName='Direct')]
param(
    [Parameter(Mandatory=$true,ParameterSetName='Direct')][string]$NodePath,
    [Parameter(Mandatory=$true,ParameterSetName='Direct')][string]$CliPath,
    [Parameter(Mandatory=$true,ParameterSetName='Direct')][string]$ConfigPath,
    [Parameter(Mandatory=$true,ParameterSetName='Registered')][string]$RegistrationPath,
    [Parameter(Mandatory=$true)][string]$InputPath
)
$ErrorActionPreference = 'Stop'
try {
    if ($PSCmdlet.ParameterSetName -eq 'Registered') {
        # Keep installation paths out of Explorer's length-limited command line.
        # This is private installation data, never executable PowerShell source.
        $registration = Get-Content -LiteralPath $RegistrationPath -Raw | ConvertFrom-Json
        $NodePath = $registration.nodePath
        $CliPath = $registration.cliPath
        $ConfigPath = $registration.configPath
        foreach ($target in @($NodePath,$CliPath,$ConfigPath)) {
            if (-not $target -or -not [IO.Path]::IsPathRooted($target) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
                throw 'Ask Malyn needs its Explorer registration repaired. Turn Ask Malyn off and on in Preferences.'
            }
        }
    }
    # Pass filenames as arguments; never evaluate them as PowerShell or cmd source.
    $result = & $NodePath $CliPath ask $InputPath --config $ConfigPath 2>&1
    if($LASTEXITCODE -ne 0){throw ($result -join "`n")}
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Ask Malyn',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}
