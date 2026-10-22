param(
    [ValidateSet('Install','Uninstall','Status')][string]$Action = 'Status',
    [switch]$ReplaceRunning
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $projectRoot '.windows-service'
$serviceName = 'CodexRemote'
if ($Action -eq 'Status') {
    Get-Service $serviceName -ErrorAction SilentlyContinue
    exit
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script in an administrator PowerShell window.'
}
New-Item $runtimeDir -ItemType Directory -Force | Out-Null
Start-Transcript -Path (Join-Path $runtimeDir 'install.log') -Append | Out-Null
try {
    $existing = Get-Service $serviceName -ErrorAction SilentlyContinue
    if ($Action -eq 'Uninstall') {
        if ($existing) {
            Stop-Service $serviceName -Force
            & sc.exe delete $serviceName
            if ($LASTEXITCODE -ne 0) { throw 'Service deletion failed.' }
        }
        return
    }
    if ($existing) { throw 'Service already installed. Use services.msc to manage it, or uninstall first.' }
    $nodePath = (Get-Command node.exe).Source
    $configPath = Join-Path $runtimeDir 'config.xml'
    if (-not (Test-Path $configPath)) {
        $xml = New-Object Xml.XmlDocument
        $service = $xml.CreateElement('service'); $null = $xml.AppendChild($service)
        $node = $xml.CreateElement('node'); $node.InnerText = $nodePath; $null = $service.AppendChild($node)
        foreach ($name in @('PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','CODEX_BIN')) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if ($name -eq 'CODEX_HOME' -and -not $value) { $value = Join-Path $env:USERPROFILE '.codex' }
            if ($value) { $item = $xml.CreateElement('env'); $item.SetAttribute('name',$name); $item.InnerText = $value; $null = $service.AppendChild($item) }
        }
        $xml.Save($configPath)
    }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $exe = Join-Path $runtimeDir 'CodexRemote.exe'
    & $compiler /nologo /target:winexe /reference:System.ServiceProcess.dll "/out:$exe" (Join-Path $PSScriptRoot 'windows-service.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Service wrapper compilation failed.' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8789,8790 -ErrorAction SilentlyContinue)
    if ($listeners.Count -and -not $ReplaceRunning) { throw 'Ports 8789/8790 are occupied. Re-run with -ReplaceRunning only when terminal tasks can be interrupted.' }
    foreach ($ownerId in ($listeners.OwningProcess | Sort-Object -Unique)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
        if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch '(server\.mjs.*--terminal|scripts[/\\]start-history\.mjs)') {
            throw "Port belongs to an unrecognized process ($ownerId); no processes stopped."
        }
    }
    foreach ($ownerId in ($listeners.OwningProcess | Sort-Object -Unique)) {
        & taskkill.exe /PID $ownerId /T /F
        if ($LASTEXITCODE -ne 0) { throw "Could not stop process $ownerId" }
    }
    New-Service -Name $serviceName -DisplayName 'Codex Remote' -BinaryPathName ('"' + $exe + '"') -StartupType Automatic -Description 'Codex terminal 8789 and history gateway 8790. Logs: .windows-service/logs. Runs as LocalSystem using configured Codex profile.' | Out-Null
    & sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/15000/restart/60000
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure automatic recovery.' }
    & sc.exe config $serviceName start= delayed-auto
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure delayed automatic startup.' }
    # Retire the legacy logon launcher before SCM takes ownership of Node.
    # Keep its tunnel command: the Windows service manages only Node servers.
    $startupFile = Join-Path ([Environment]::GetFolderPath('Startup')) 'CodexRemote.vbs'
    if (Test-Path -LiteralPath $startupFile) {
        $startupLines = Get-Content -LiteralPath $startupFile
        if (($startupLines -join "`n").Contains($projectRoot)) {
            Copy-Item -LiteralPath $startupFile -Destination ($startupFile + '.before-service-install.bak') -Force
            $startupLines | Where-Object { $_ -notmatch 'server\.mjs --terminal' } | Set-Content -LiteralPath $startupFile -Encoding ascii
        }
    }
    Start-Service $serviceName
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $a = Invoke-WebRequest 'http://127.0.0.1:8789/' -UseBasicParsing -TimeoutSec 2
            $b = Invoke-WebRequest 'http://127.0.0.1:8790/' -UseBasicParsing -TimeoutSec 2
            if ($a.StatusCode -eq 200 -and $b.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw 'Service installed but HTTP checks failed. Inspect .windows-service/logs.' }
    Get-Service $serviceName
    'Both HTTP endpoints verified. Installation complete.'
} finally { Stop-Transcript | Out-Null }
