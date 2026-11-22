@echo off
REM DeepEggy 本地一键启动（Windows 双击运行）
REM 用法：双击本文件，或在项目根目录执行 scripts\start_local.bat
REM
REM Key 放在 scripts\env.local（已在 .gitignore，不会提交）。
REM 第一次用：把 scripts\env.local.example 复制成 scripts\env.local，再填自己的 Key。

set PYTHONUTF8=1

if exist "%~dp0env.local" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0env.local") do (
    echo %%a| findstr /b /c:"#" >nul || set "%%a=%%b"
  )
)

set PORT=8080

cd /d "%~dp0.."
echo DeepEggy 本地启动中：http://127.0.0.1:%PORT%/
if defined DEEPSEEK_API_KEY (
  echo AI 解读：已配置
) else (
  echo AI 解读：未配置（仅界面可用）—— 把 scripts\env.local.example 复制成 scripts\env.local 再填 Key
)
python -m app.backend.main
pause
