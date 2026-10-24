@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem ---------------------------------------------------------------
rem Start the Codex CLI that lives in .Allinone\MCP\agents\codex.
rem All Codex data (config, login, sessions, logs, temp) goes to
rem agents\codex\home. Nothing outside this window is changed.
rem
rem   codex.cmd            open Codex
rem   codex.cmd login      sign in (ChatGPT account)
rem   codex.cmd <args>     any other Codex command
rem ---------------------------------------------------------------

call "%~dp0_env.cmd"

set "CODEX_DIR=%AIO_MCP%\agents\codex"
set "CODEX_HOME=%CODEX_DIR%\home"
set "CODEX_SQLITE_HOME=%CODEX_HOME%\sqlite"
set "TEMP=%CODEX_HOME%\tmp"
set "TMP=%CODEX_HOME%\tmp"
for %%D in ("%CODEX_HOME%" "%CODEX_SQLITE_HOME%" "%TEMP%") do if not exist "%%~D" mkdir "%%~D"

rem Codex ships its own ripgrep in codex-path.
set "PATH=%CODEX_DIR%\bin\codex-path;%CODEX_DIR%\bin;%PATH%"

title Codex (.Allinone)

rem Work in the shared projects folder, not in launch\.
cd /d "%AIO_MCP%\projects"

"%CODEX_DIR%\bin\codex-x86_64-pc-windows-msvc.exe" %*

if errorlevel 1 (
  echo.
  echo [Codex exited with an error. Window stays open so you can read it.]
  pause
)

endlocal
