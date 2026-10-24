@echo off
rem Double-click: numbered menu for the .Allinone hub (health, quota, dispatch, board, trash, self-test).
rem Keep this file ASCII-only.
chcp 65001 >nul
call "%~dp0_env.cmd"
cd /d "%AIO_MCP%\projects"
title .Allinone hub
"%AIO_NODE%\node.exe" "%AIO_MCP%\protocol\hub\aio.mjs" menu
