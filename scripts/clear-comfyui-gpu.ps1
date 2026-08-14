<#
.SYNOPSIS
Releases GPU memory held by a local ComfyUI instance.

.DESCRIPTION
Calls ComfyUI's /free endpoint to unload models and release cached GPU memory.
By default, the script refuses to run while prompts are active or pending.
Use -Force to interrupt the active prompt and clear the pending queue first.

.PARAMETER ComfyUrl
Base URL of the ComfyUI instance. Defaults to the local loopback service.

.PARAMETER Force
Interrupts the active prompt and clears pending prompts before freeing GPU memory.
This discards queued work.

.EXAMPLE
.\scripts\clear-comfyui-gpu.ps1

.EXAMPLE
.\scripts\clear-comfyui-gpu.ps1 -Force -Confirm
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidatePattern('^https?://')]
    [string]$ComfyUrl = 'http://127.0.0.1:8188',

    [switch]$Force,

    [ValidateRange(1, 120)]
    [int]$TimeoutSec = 10
)

$ErrorActionPreference = 'Stop'
$baseUrl = $ComfyUrl.TrimEnd('/')

function Invoke-ComfyPost {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [hashtable]$Body = @{}
    )

    $request = @{
        Uri         = "$baseUrl$Path"
        Method      = 'Post'
        TimeoutSec  = $TimeoutSec
        ContentType = 'application/json'
        Body        = ($Body | ConvertTo-Json -Compress)
    }

    Invoke-RestMethod @request | Out-Null
}

function Get-ComfyQueueState {
    $queue = Invoke-RestMethod -Uri "$baseUrl/queue" -TimeoutSec $TimeoutSec
    [pscustomobject]@{
        Running = @($queue.queue_running).Count
        Pending = @($queue.queue_pending).Count
    }
}

function Get-ComfyGpuState {
    $stats = Invoke-RestMethod -Uri "$baseUrl/system_stats" -TimeoutSec $TimeoutSec
    $devices = @($stats.devices)
    if ($devices.Count -eq 0) {
        return @()
    }

    $devices | ForEach-Object {
        [pscustomobject]@{
            Name       = $_.name
            VramUsedMB = if ($null -ne $_.vram_total -and $null -ne $_.vram_free) {
                [math]::Round(($_.vram_total - $_.vram_free) / 1MB)
            } else {
                $null
            }
            VramFreeMB = if ($null -ne $_.vram_free) {
                [math]::Round($_.vram_free / 1MB)
            } else {
                $null
            }
        }
    }
}

$queueState = Get-ComfyQueueState
$hasQueuedWork = $queueState.Running -gt 0 -or $queueState.Pending -gt 0

if ($hasQueuedWork -and -not $Force) {
    throw "ComfyUI is busy (running=$($queueState.Running), pending=$($queueState.Pending)). Re-run with -Force to interrupt and discard queued work."
}

$operation = if ($Force -and $hasQueuedWork) {
    'interrupt active work, clear the queue, unload models, and free GPU memory'
} else {
    'unload models and free GPU memory'
}

if (-not $PSCmdlet.ShouldProcess($baseUrl, $operation)) {
    return
}

if ($Force -and $hasQueuedWork) {
    Invoke-ComfyPost -Path '/interrupt'
    Invoke-ComfyPost -Path '/queue' -Body @{ clear = $true }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSec)
    do {
        Start-Sleep -Milliseconds 250
        $queueState = Get-ComfyQueueState
    } while ($queueState.Running -gt 0 -and [DateTimeOffset]::UtcNow -lt $deadline)

    if ($queueState.Running -gt 0) {
        throw "ComfyUI did not stop the active prompt within $TimeoutSec seconds. GPU memory was not freed."
    }
}

Invoke-ComfyPost -Path '/free' -Body @{
    unload_models = $true
    free_memory    = $true
}

Start-Sleep -Milliseconds 500
$finalQueue = Get-ComfyQueueState
$gpuState = Get-ComfyGpuState

Write-Host "ComfyUI GPU release requested successfully."
Write-Host "Queue: running=$($finalQueue.Running), pending=$($finalQueue.Pending)"
if (@($gpuState).Count -gt 0) {
    $gpuState | Format-Table -AutoSize
}
