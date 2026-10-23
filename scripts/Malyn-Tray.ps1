param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$CliPath,
    [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public static class MalynClipboard { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }'
$config = [IO.Path]::GetFullPath($ConfigPath)
$directory = Split-Path -Parent $config
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.ToLowerInvariant())))).Replace('-','') } finally { $hash.Dispose() }
$mutex = New-Object Threading.Mutex($false,('Local\MalynTray-' + $key))
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }
$stateFile = Join-Path $directory 'tray-session.json'
$stopFile = Join-Path $directory 'tray-stop'
$icon = New-Object Windows.Forms.NotifyIcon
$menu = New-Object Windows.Forms.ContextMenuStrip
$timer = New-Object Windows.Forms.Timer
$application = New-Object Windows.Forms.ApplicationContext
$bitmap = $null
$ownedIcon = $null
$script:screenshotEnabled = $false
$script:clipboardSequence = [MalynClipboard]::GetClipboardSequenceNumber()
$script:pendingScreenshot = $null
$script:watchedScreenshot = $null
$script:notificationJob = $null
function Show-MalynNotice([string]$Message,[string]$JobId = '',[string]$Status = '') {
    $script:notificationJob = $JobId
    $icon.BalloonTipTitle = 'Malyn'
    $icon.BalloonTipText = $Message
    $icon.BalloonTipIcon = [Windows.Forms.ToolTipIcon]::Info
    $icon.ShowBalloonTip(6000)
    # This records a notification request, not proof Windows displayed it.
    [IO.File]::WriteAllText((Join-Path $directory 'last-notification.json'),(@{jobId=$JobId;status=$Status;requestedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
}
function Invoke-MalynBackground([string[]]$Arguments) {
    $argumentsText = (@($CliPath,'--config',$config) + $Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    Start-Process -FilePath $NodePath -ArgumentList $argumentsText -WindowStyle Hidden | Out-Null
}
function Read-MalynTrayState {
    $paused = $false
    $control = Join-Path $directory 'control.json'
    $enabled = $false
    if (Test-Path -LiteralPath $control) { $settings=Get-Content -LiteralPath $control -Raw | ConvertFrom-Json; $paused=[bool]$settings.paused; $enabled=[bool]$settings.screenshotMode }
    if($enabled -ne $script:screenshotEnabled){$script:clipboardSequence=[MalynClipboard]::GetClipboardSequenceNumber();$script:screenshotEnabled=$enabled}
    $screenshotItem.Checked=$enabled
    $screenshotItem.Text=if($enabled){'Screenshot mode: on'}else{'Screenshot mode: off'}
    $working = $false
    $workerLock = Join-Path $directory 'jobs\worker.lock'
    if (Test-Path -LiteralPath $workerLock) {
        $worker = Get-Content -LiteralPath $workerLock -Raw | ConvertFrom-Json
        $working = [bool](Get-Process -Id $worker.pid -ErrorAction SilentlyContinue)
    }
    $script:trayPaused = $paused
    $script:trayWorking = $working
    $label = if ($working -and $paused) { 'Working; new tasks paused' } elseif ($working) { 'Working locally' } elseif ($paused) { 'New tasks paused' } else { 'Accepting tasks' }
    $icon.Text = 'Malyn - ' + $label + $(if($enabled){' - screenshots on'}else{''})
    $stateItem.Text = $label
    $pauseItem.Text = if ($paused) { 'Resume new tasks' } else { 'Pause new tasks' }
}
function Read-MalynScreenshots {
    if($script:pendingScreenshot -and $script:pendingScreenshot.Process.HasExited){
        try {
            # Start-Process can lose ExitCode after a fast process exits; validate its result instead.
            $submitted=Get-Content -LiteralPath $script:pendingScreenshot.Output -Raw | ConvertFrom-Json
            if($submitted.status -ne 'running' -or $submitted.id -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'No job was submitted.'}
            $script:watchedScreenshot=$submitted.id
        } catch { Show-MalynNotice 'Screenshot analysis could not start. Check local settings, allowed roots and diagnostics.' '' 'submission-failed' }
        finally {$script:pendingScreenshot.Process.Dispose();$script:pendingScreenshot=$null}
    }
    if($script:watchedScreenshot){
        $job=Get-Content -LiteralPath (Join-Path $directory ('jobs\'+$script:watchedScreenshot+'\status.json')) -Raw | ConvertFrom-Json
        if($job.status -ne 'running'){
            $message=if($job.status -eq 'completed'){'Screenshot analysis ready. Click to open the local report.'}else{'Screenshot analysis did not finish. Click to open its local job status.'}
            Show-MalynNotice $message $script:watchedScreenshot $job.status
            $script:watchedScreenshot=$null
        } elseif(-not (Get-Process -Id $job.pid -ErrorAction SilentlyContinue)) {
            Show-MalynNotice 'Screenshot analysis was interrupted. Click to open its local job status.' $script:watchedScreenshot 'interrupted'
            $script:watchedScreenshot=$null
        }
    }
    if(-not $script:screenshotEnabled){return}
    $sequence=[MalynClipboard]::GetClipboardSequenceNumber()
    if($sequence -eq $script:clipboardSequence){return}
    # Only inspect images after an enabled-mode clipboard change. Never read text.
    if(-not [Windows.Forms.Clipboard]::ContainsImage()){$script:clipboardSequence=$sequence;return}
    if($script:trayPaused -or $script:trayWorking -or $script:pendingScreenshot -or $script:watchedScreenshot){
        $script:clipboardSequence=$sequence
        Show-MalynNotice 'Screenshot skipped: Malyn is paused or busy. Copy it again when ready.' '' 'skipped'
        return
    }
    $captureRoot=Join-Path $directory 'captures'
    New-Item -ItemType Directory -Path $captureRoot -Force | Out-Null
    if((Get-Item -LiteralPath $captureRoot).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked capture directories are excluded.'}
    $stem='screenshot-'+[guid]::NewGuid().ToString('N')
    $capture=Join-Path $captureRoot ($stem+'.png')
    $picture=[Windows.Forms.Clipboard]::GetImage()
    if(-not $picture){return}
    try{$picture.Save($capture,[Drawing.Imaging.ImageFormat]::Png)}finally{$picture.Dispose()}
    $script:clipboardSequence=$sequence
    if((Get-Item -LiteralPath $capture).Length -gt 10MB){Remove-Item -LiteralPath $capture;Show-MalynNotice 'Screenshot exceeds the 10 MiB image limit. Capture a smaller region.' '' 'too-large';return}
    $output=Join-Path $captureRoot ($stem+'.submission.json')
    $errors=Join-Path $captureRoot ($stem+'.error.txt')
    $argumentsText=(@($CliPath,'--config',$config,'ask',$capture,'--no-open') | ForEach-Object {'"'+$_+'"'}) -join ' '
    $process=Start-Process -FilePath $NodePath -ArgumentList $argumentsText -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errors -PassThru
    $script:pendingScreenshot=@{Process=$process;Output=$output}
}
try {
    $imagePath = Join-Path (Split-Path -Parent (Split-Path -Parent $CliPath)) 'src\ui\tray.png'
    if (Test-Path -LiteralPath $imagePath) {
        $sourceImage = [Drawing.Image]::FromFile($imagePath)
        try { $bitmap = New-Object Drawing.Bitmap($sourceImage, (New-Object Drawing.Size(32,32))) } finally { $sourceImage.Dispose() }
        Add-Type 'using System; using System.Runtime.InteropServices; public static class MalynNativeIcon { [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon); }'
        $handle = $bitmap.GetHicon()
        try { $ownedIcon = [Drawing.Icon]::FromHandle($handle).Clone() } finally { [MalynNativeIcon]::DestroyIcon($handle) | Out-Null }
        $icon.Icon = $ownedIcon
    } else { $icon.Icon = [Drawing.SystemIcons]::Application }
    $stateItem = $menu.Items.Add('Malyn'); $stateItem.Enabled = $false
    $menu.Items.Add('-') | Out-Null
    $openItem = $menu.Items.Add('Open Malyn'); $openItem.Add_Click({ Invoke-MalynBackground @('ui') })
    $settingsItem = $menu.Items.Add('Settings and admin'); $settingsItem.Add_Click({ Invoke-MalynBackground @('ui','--section','settings') })
    $pauseItem = $menu.Items.Add('Pause new tasks'); $pauseItem.Add_Click({ if ($script:trayPaused) { Invoke-MalynBackground @('resume') } else { Invoke-MalynBackground @('pause') } })
    $screenshotItem=$menu.Items.Add('Screenshot mode: off');$screenshotItem.Add_Click({if($script:screenshotEnabled){Invoke-MalynBackground @('screenshots','off')}else{Invoke-MalynBackground @('screenshots','on')}})
    $resultsItem = $menu.Items.Add('Open results folder'); $resultsItem.Add_Click({
        $results = Join-Path $directory 'jobs'
        if (Test-Path -LiteralPath $results) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $results + '"') }
    })
    $menu.Items.Add('-') | Out-Null
    $quitItem = $menu.Items.Add('Quit tray and admin UI'); $quitItem.Add_Click({ Invoke-MalynBackground @('ui-stop'); $application.ExitThread() })
    $icon.ContextMenuStrip = $menu
    $icon.Add_DoubleClick({ Invoke-MalynBackground @('ui') })
    $icon.Add_BalloonTipClicked({if($script:notificationJob){Invoke-MalynBackground @('ui','--job',$script:notificationJob)}else{Invoke-MalynBackground @('ui','--section','jobs')}})
    Read-MalynTrayState
    $icon.Visible = $true
    [IO.File]::WriteAllText($stateFile,(@{pid=$PID;configPath=$config;iconVisible=$icon.Visible;startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    $timer.Interval = 3000
    $timer.Add_Tick({
        try {
            if ((Test-Path -LiteralPath $stopFile) -and (Get-Content -LiteralPath $stopFile -Raw).Trim() -eq [string]$PID) { $application.ExitThread(); return }
            Read-MalynTrayState
            Read-MalynScreenshots
            $snapshot=@{pid=$PID;configPath=$config;iconVisible=$icon.Visible;screenshotMode=$script:screenshotEnabled;clipboardSequence=$script:clipboardSequence;observedSequence=[MalynClipboard]::GetClipboardSequenceNumber();pendingScreenshot=[bool]$script:pendingScreenshot;watchedScreenshot=$script:watchedScreenshot;updatedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json
            [IO.File]::WriteAllText(($stateFile+'.tmp'),$snapshot,(New-Object Text.UTF8Encoding($false)))
            Move-Item -LiteralPath ($stateFile+'.tmp') -Destination $stateFile -Force
        } catch {
            $icon.Text = 'Malyn - Open settings to check status'
            [IO.File]::WriteAllText((Join-Path $directory 'tray-error.txt'),$_.Exception.ToString())
        }
    })
    $timer.Start()
    [Windows.Forms.Application]::Run($application)
} catch {
    [IO.File]::WriteAllText((Join-Path $directory 'tray-error.txt'),$_.Exception.Message)
} finally {
    $timer.Stop(); $timer.Dispose(); $icon.Visible=$false; $icon.Dispose(); $menu.Dispose(); $application.Dispose()
    if ($ownedIcon) { $ownedIcon.Dispose() }; if ($bitmap) { $bitmap.Dispose() }
    if (Test-Path -LiteralPath $stateFile) { $stored = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json; if ($stored.pid -eq $PID) { Remove-Item -LiteralPath $stateFile } }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
