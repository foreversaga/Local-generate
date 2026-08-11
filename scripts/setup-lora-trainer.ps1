[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$SdScriptsCommit = '6721028c79ee85a78b3a06dfd8954dae310a1cce',

    [string]$LoraTrainingRoot = $env:LORA_TRAINING_ROOT,

    [string]$PythonExecutable,

    [ValidatePattern('^3\.10(?:\.\d+)?$')]
    [string]$PythonVersion = '3.10',

    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$RepositoryUri = 'https://github.com/kohya-ss/sd-scripts.git'

if ([string]::IsNullOrWhiteSpace($LoraTrainingRoot)) {
    throw 'Set LORA_TRAINING_ROOT or pass -LoraTrainingRoot.'
}
$root = [System.IO.Path]::GetFullPath($LoraTrainingRoot)
$rootInfo = [System.IO.DirectoryInfo]::new($root)
if ($rootInfo.Parent -eq $null) { throw 'LORA_TRAINING_ROOT cannot be a filesystem root.' }
$runtime = [System.IO.Path]::GetFullPath((Join-Path $root 'runtime'))
if (-not $runtime.StartsWith($root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved runtime path escaped LORA_TRAINING_ROOT.'
}
$repository = Join-Path $runtime 'sd-scripts'
$venv = Join-Path $runtime 'venv'
$git = (Get-Command git.exe -ErrorAction Stop).Source
$venvPython = Join-Path $venv 'Scripts\python.exe'

if ($Resume -and -not [string]::IsNullOrWhiteSpace($PythonExecutable)) {
    throw 'PythonExecutable is only used to create a fresh virtual environment; omit it when using -Resume.'
}

if ($Resume) {
    if (-not (Test-Path -LiteralPath $repository -PathType Container) -or -not (Test-Path -LiteralPath $venv -PathType Container)) {
        throw "Resume requires both the existing repository and virtual environment: $repository ; $venv"
    }
    if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
        throw "Resume runtime directory is missing: $runtime"
    }
    $runtimeItem = Get-Item -LiteralPath $runtime -Force
    if (($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Resume runtime must not be a symbolic link or reparse point: $runtime"
    }
    if (-not [string]::Equals([System.IO.Path]::GetFullPath($runtimeItem.FullName), $runtime, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resume runtime did not resolve to its exact expected path: $runtime"
    }
    $runtimePrefix = $runtime.TrimEnd('\') + '\'
    $resumeDirectories = @(
        [PSCustomObject]@{ Path = $repository; Label = 'repository' }
        [PSCustomObject]@{ Path = $venv; Label = 'virtual environment' }
    )
    foreach ($candidate in $resumeDirectories) {
        $candidatePath = [System.IO.Path]::GetFullPath([string]$candidate.Path)
        if (-not $candidatePath.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Resume $($candidate.Label) escaped the runtime directory: $candidatePath"
        }
        $candidateItem = Get-Item -LiteralPath $candidatePath -Force
        if (-not $candidateItem.PSIsContainer -or ($candidateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Resume $($candidate.Label) must be a direct physical directory, not a link or reparse point: $candidatePath"
        }
        if (-not [string]::Equals([System.IO.Path]::GetFullPath($candidateItem.FullName), $candidatePath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Resume $($candidate.Label) did not resolve to its exact expected path: $candidatePath"
        }
    }
    $resolvedCommitOutput = & $git -C $repository rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $null -eq $resolvedCommitOutput) {
        throw 'Resume repository HEAD could not be read.'
    }
    $resolvedCommit = ([string]$resolvedCommitOutput).Trim()
    if ($resolvedCommit -ne $SdScriptsCommit.ToLowerInvariant()) {
        throw 'Resume repository HEAD does not match the requested pinned sd-scripts commit.'
    }
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        throw "Resume virtual environment Python is missing: $venvPython"
    }
    $venvPythonItem = Get-Item -LiteralPath $venvPython -Force
    if (($venvPythonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Resume virtual environment Python must not be a link or reparse point: $venvPython"
    }
    if (-not [string]::Equals([System.IO.Path]::GetFullPath($venvPythonItem.FullName), [System.IO.Path]::GetFullPath($venvPython), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resume virtual environment Python did not resolve to its exact expected path: $venvPython"
    }
    & $venvPython -c "import os, sys; ok = sys.version_info[:2] == (3, 10) and os.path.isfile(sys.executable); raise SystemExit(0 if ok else 1)"
    if ($LASTEXITCODE -ne 0) {
        throw "Resume virtual environment must contain a working Python 3.10 executable: $venvPython"
    }
} else {
    if (Test-Path -LiteralPath $repository) { throw "Refusing to replace existing repository (use -Resume only with a complete matching runtime): $repository" }
    if (Test-Path -LiteralPath $venv) { throw "Refusing to replace existing virtual environment (use -Resume only with a complete matching runtime): $venv" }

    $pythonForVenv = $null
    $venvBootstrapArguments = $null
    if (-not [string]::IsNullOrWhiteSpace($PythonExecutable)) {
        try {
            $pythonForVenv = [System.IO.Path]::GetFullPath($PythonExecutable)
        } catch {
            throw "PythonExecutable is not a valid path: $($_.Exception.Message)"
        }
        if (-not (Test-Path -LiteralPath $pythonForVenv -PathType Leaf)) {
            throw "PythonExecutable is not an existing file: $pythonForVenv"
        }
        $pythonItem = Get-Item -LiteralPath $pythonForVenv -Force
        if (($pythonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "PythonExecutable must be a direct file, not a symbolic link or reparse point: $pythonForVenv"
        }
        try {
            & $pythonForVenv -c "import os, sys; ok = sys.version_info[:2] == (3, 10) and bool(sys.executable) and os.path.isfile(sys.executable) and os.access(sys.executable, os.X_OK); raise SystemExit(0 if ok else 1)"
        } catch {
            throw "PythonExecutable could not be executed: $pythonForVenv"
        }
        if ($LASTEXITCODE -ne 0) {
            throw "PythonExecutable must be an executable Python 3.10 binary with a valid sys.executable: $pythonForVenv"
        }
        $venvBootstrapArguments = @('-m', 'venv', $venv)
    } else {
        try {
            $pythonForVenv = (Get-Command py.exe -ErrorAction Stop).Source
        } catch {
            throw 'Python launcher (py.exe) was not found. Pass -PythonExecutable with the exact Python 3.10 executable path.'
        }
        & $pythonForVenv "-$PythonVersion" -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 10) else 1)"
        if ($LASTEXITCODE -ne 0) {
            throw 'Python 3.10 is not available through py.exe. Pass -PythonExecutable with the exact Python 3.10 executable path.'
        }
        $venvBootstrapArguments = @("-$PythonVersion", '-m', 'venv', $venv)
    }

    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    & $git clone --filter=blob:none --no-checkout $RepositoryUri $repository
    if ($LASTEXITCODE -ne 0) { throw 'sd-scripts clone failed.' }
    & $git -C $repository fetch --depth 1 origin $SdScriptsCommit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned sd-scripts commit fetch failed.' }
    & $git -C $repository checkout --detach $SdScriptsCommit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned sd-scripts checkout failed.' }
    $resolvedCommit = (& $git -C $repository rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $SdScriptsCommit.ToLowerInvariant()) {
        throw 'Checked-out sd-scripts revision does not match the requested pin.'
    }

    & $pythonForVenv @venvBootstrapArguments
    if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed.' }
}

& $venvPython -m pip install --disable-pip-version-check 'pip==24.3.1'
if ($LASTEXITCODE -ne 0) { throw 'Pinned pip installation failed.' }
& $venvPython -m pip install --disable-pip-version-check --index-url 'https://download.pytorch.org/whl/cu128' 'torch==2.8.0' 'torchvision==0.23.0'
if ($LASTEXITCODE -ne 0) { throw 'Pinned CUDA 12.8 PyTorch installation failed.' }
$requirementsExitCode = $null
Push-Location -LiteralPath $repository
try {
    & $venvPython -m pip install --disable-pip-version-check --upgrade --upgrade-strategy only-if-needed -r (Join-Path $repository 'requirements.txt')
    $requirementsExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($requirementsExitCode -ne 0) { throw 'sd-scripts dependency installation failed while running from the repository directory.' }
& $venvPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'LoRA trainer dependency consistency check failed.' }
& $venvPython -c "import torch, torchvision; assert torch.__version__.split('+')[0] == '2.8.0', torch.__version__; assert torchvision.__version__.split('+')[0] == '0.23.0', torchvision.__version__; assert torch.version.cuda == '12.8', torch.version.cuda; assert torch.cuda.is_available(), 'CUDA is not available'"
if ($LASTEXITCODE -ne 0) { throw 'Pinned torch/torchvision, CUDA 12.8, or GPU availability verification failed.' }

Write-Host "LoRA trainer runtime prepared at $runtime" -ForegroundColor Green
Write-Host "sd-scripts commit: $resolvedCommit"
Write-Host 'torch==2.8.0 and torchvision==0.23.0 are pinned for CUDA 12.8.'
Write-Warning 'The selected sd-scripts commit and torch packages are pinned; upstream requirements.txt is not a fully locked dependency set.'
Write-Host 'Base checkpoints and preset-specific settings are intentionally not downloaded or configured by this script.'
