@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem ---------------------------------------------------------------
rem Start the DeepSeek Harness (dsh) that lives in
rem .Allinone\MCP\agents\deepseek. All dsh data (profiles, sessions,
rem credentials, cache, temp) goes to agents\deepseek\home.
rem Nothing outside this window is changed.
rem
rem   dsh.cmd                   (double-click) open the web GUI in your browser;
rem                             it keeps running until you close this window
rem   dsh.cmd headless "task"   answer one task and exit
rem   dsh.cmd --help            all options
rem
rem DeepSeek API key: put it, alone on one line, in
rem   agents\deepseek\home\deepseek-api-key.txt
rem It is loaded into this window only and never written anywhere else.
rem ---------------------------------------------------------------

call "%~dp0_env.cmd"

set "DSH_DIR=%AIO_MCP%\agents\deepseek"
set "DSH_HOME=%DSH_DIR%\home"
set "DSH_AGENTS_HOME=%DSH_HOME%\.agents"
set "TEMP=%DSH_HOME%\tmp"
set "TMP=%DSH_HOME%\tmp"
set "DSH_TELEMETRY_DISABLED=1"
for %%D in ("%DSH_HOME%" "%DSH_AGENTS_HOME%" "%TEMP%") do if not exist "%%~D" mkdir "%%~D"

set "DEEPSEEK_API_KEY="
if exist "%DSH_HOME%\deepseek-api-key.txt" set /p DEEPSEEK_API_KEY=<"%DSH_HOME%\deepseek-api-key.txt"

title dsh (.Allinone)

rem Work in the shared projects folder, not in launch\.
cd /d "%AIO_MCP%\projects"

if "%~1"=="" (
  rem Double-click: serve the web GUI on a free port so it never clashes
  rem with the DSH desktop app, and keep the window open afterwards.
  echo Starting the DSH web GUI. Close this window to stop it.
  echo.
  call "%DSH_DIR%\bin\node_modules\.bin\dsh.cmd" web --port 0
  echo.
  echo [dsh has stopped.]
  pause
  goto :end
)

call "%DSH_DIR%\bin\node_modules\.bin\dsh.cmd" %*

if errorlevel 1 (
  echo.
  echo [dsh exited with an error. Window stays open so you can read it.]
  pause
)

:end

endlocal
