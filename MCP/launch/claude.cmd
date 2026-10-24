@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem ---------------------------------------------------------------
rem Start the Claude Code CLI that lives in .Allinone\MCP\agents\claude.
rem All Claude Code data (settings, login, sessions, plugins, temp)
rem goes to agents\claude\home. Nothing outside this window is changed.
rem
rem   claude.cmd           open Claude Code (first run asks you to sign in)
rem   claude.cmd <args>    any other Claude Code command, e.g. -p "task"
rem ---------------------------------------------------------------

call "%~dp0_env.cmd"

set "CLAUDE_DIR=%AIO_MCP%\agents\claude"
set "CLAUDE_CONFIG_DIR=%CLAUDE_DIR%\home"
set "CLAUDE_CODE_TMPDIR=%CLAUDE_CONFIG_DIR%\tmp"
for %%D in ("%CLAUDE_CONFIG_DIR%" "%CLAUDE_CODE_TMPDIR%") do if not exist "%%~D" mkdir "%%~D"

rem This copy is updated by hand (winget), never by the built-in updater,
rem which would install into %USERPROFILE%\.local instead.
set "DISABLE_AUTOUPDATER=1"

rem Use the Claude subscription login. If an API key were set, -p mode
rem would bill the API instead of the subscription.
set "ANTHROPIC_API_KEY="

rem Dispatching a sub-task through the aio-hub MCP server can take many
rem minutes; allow MCP tool calls up to 30 minutes.
set "MCP_TOOL_TIMEOUT=1800000"

title Claude Code (.Allinone)

rem Work in the shared projects folder, not in launch\.
cd /d "%AIO_MCP%\projects"

"%CLAUDE_DIR%\bin\claude.exe" %*

if errorlevel 1 (
  echo.
  echo [Claude Code exited with an error. Window stays open so you can read it.]
  pause
)

endlocal
