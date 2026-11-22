$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $projectRoot 'app\.venv'
$venvPython = Join-Path $venvPath 'Scripts\python.exe'
$modelHome = Join-Path $projectRoot 'data\models\paddlex'

$basePython = $null
$projectPython = Join-Path $projectRoot 'app\.python312\python.exe'
if (Test-Path -LiteralPath $projectPython) {
    $version = & $projectPython -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
    if ($LASTEXITCODE -eq 0 -and $version -eq '3.12') {
        $basePython = $projectPython
    }
}

$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if (-not $basePython -and $pyLauncher) {
    $candidate = & py -3.12 -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $candidate -and (Test-Path -LiteralPath $candidate)) {
        $basePython = $candidate.Trim()
    }
}

if (-not $basePython) {
    throw '需要先安装 Python 3.12 x64。可使用已安装的 py -3.12，或把便携运行时放到 app\.python312；官方 RTX 50 系 Windows 指南要求 Python 3.8–3.12。'
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    & $basePython -m venv $venvPath
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install 'paddlepaddle-gpu==3.2.1' -i 'https://www.paddlepaddle.org.cn/packages/stable/cu129/'
& $venvPython -m pip install 'https://xly-devops.cdn.bcebos.com/safetensors-nightly/safetensors-0.6.2.dev0-cp38-abi3-win_amd64.whl'
& $venvPython -m pip install -r (Join-Path $projectRoot 'requirements-ocr.txt')

New-Item -ItemType Directory -Path $modelHome -Force | Out-Null
$env:PADDLEX_HOME = $modelHome
$env:PADDLE_PDX_MODEL_SOURCE = 'BOS'

& $venvPython -c 'import paddle; print("Paddle:", paddle.__version__); print("CUDA build:", paddle.is_compiled_with_cuda()); print("Device:", paddle.device.get_device()); assert paddle.is_compiled_with_cuda(), "Installed PaddlePaddle is not a GPU build"'
if ($LASTEXITCODE -ne 0) {
    throw 'GPU 运行环境未通过检查。请核对 RTX 50 系 Windows 专用安装说明和显卡驱动。'
}

Write-Host 'OCR 依赖已安装。首次识别时，PaddleOCR-VL 会把模型下载到 data\models\paddlex。'
Write-Host '模型下载需要联网，首次加载会比后续识别慢。'
