@echo off
rem Offline self-test of the dispatch hub. Calls no model, uses no tokens.
rem Keep this file ASCII-only.
chcp 65001 >nul
call "%~dp0..\MCP\launch\_env.cmd"
title .Allinone self-test
"%AIO_NODE%\node.exe" "%~dp0selftest.mjs"
echo.
pause
