$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $projectRoot 'server'

function Get-HealthyBmgPort {
    foreach ($port in @(4000, 4100)) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
            if ($health.ok -eq $true) {
                return $port
            }
        } catch {
            continue
        }
    }

    return $null
}

$healthyPort = Get-HealthyBmgPort
if ($healthyPort) {
    Write-Output "BMG backend is already available on port $healthyPort."
    exit 0
}

$serverProcess = Start-Process -FilePath 'node' `
    -ArgumentList 'src/index.js' `
    -WorkingDirectory $serverRoot `
    -WindowStyle Hidden `
    -PassThru

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $healthyPort = Get-HealthyBmgPort
    if ($healthyPort) {
        Write-Output "BMG backend started and is available on port $healthyPort."
        exit 0
    }

    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
        throw "BMG backend exited during startup with code $($serverProcess.ExitCode). Check Node.js and server dependencies."
    }
}

Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue
throw 'BMG backend did not become healthy within 20 seconds. Check Node.js, server dependencies, and ports 4000/4100.'
