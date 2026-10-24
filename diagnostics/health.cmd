@echo off
rem Health check of the .Allinone workbench. Calls no model, uses no tokens.
rem Lives in .Allinone\diagnostics; keep this file ASCII-only.
chcp 65001 >nul
call "%~dp0..\MCP\launch\_env.cmd"
cd /d "%AIO_MCP%\projects"
title .Allinone health check
"%AIO_NODE%\node.exe" "%AIO_MCP%\protocol\hub\aio.mjs" health
echo.
pause
