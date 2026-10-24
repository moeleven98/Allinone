@echo off
rem Double-click: remaining quota of Codex, Claude, Gemini and DeepSeek. Uses no tokens.
rem Keep this file ASCII-only.
chcp 65001 >nul
call "%~dp0_env.cmd"
cd /d "%AIO_MCP%\projects"
title .Allinone quota
"%AIO_NODE%\node.exe" "%AIO_MCP%\protocol\hub\aio.mjs" quota
echo.
pause
