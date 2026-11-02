@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更新版本。
  pause
  exit /b 1
)
if not exist node_modules (
  if exist package-lock.json (call npm.cmd ci) else (call npm.cmd install)
  if errorlevel 1 goto failed
)
call npm.cmd run build
if errorlevel 1 goto failed
start "" "http://127.0.0.1:4173"
call npm.cmd start
goto end
:failed
echo 启动失败，请查看上方提示。
pause
:end
