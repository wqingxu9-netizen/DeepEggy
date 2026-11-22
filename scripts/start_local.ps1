# DeepEggy 本地一键启动（Windows PowerShell）
# 用法：在项目根目录右键"在 PowerShell 中运行"，或执行：powershell -ExecutionPolicy Bypass -File scripts\start_local.ps1
#
# Key 放在 scripts\env.local（已在 .gitignore，不会提交）。
# 第一次用：把 scripts\env.local.example 复制成 scripts\env.local，再填自己的 Key。

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"

# ==== 从 scripts\env.local 读取 Key（KEY=VALUE 每行一个）====
$envFile = Join-Path $PSScriptRoot "env.local"
if (Test-Path $envFile) {
    Get-Content $envFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"))
        }
    }
}

if (-not $env:DEEPSEEK_API_KEY) {
    Write-Host "提示：没读到 DEEPSEEK_API_KEY —— 界面能打开，但 AI 解读会报「服务端未配置」。" -ForegroundColor Yellow
    Write-Host "      把 scripts\env.local.example 复制成 scripts\env.local 再填 Key 即可。" -ForegroundColor Yellow
}

# 端口（80 需要管理员权限；本地演示用 8080 即可）
if (-not $env:PORT) { $env:PORT = "8080" }

# 切到项目根目录（脚本在 scripts/ 下）
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "DeepEggy 本地启动中：http://127.0.0.1:$($env:PORT)/" -ForegroundColor Green
if ($env:DEEPSEEK_API_KEY) { Write-Host "AI 解读：已配置" -ForegroundColor Green } else { Write-Host "AI 解读：未配置（仅界面可用）" -ForegroundColor Yellow }
python -m app.backend.main
