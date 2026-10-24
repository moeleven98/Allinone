@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem ---------------------------------------------------------------
rem Start the Antigravity CLI (agy) that lives in
rem .Allinone\MCP\agents\gemini.
rem agy has no official "move my data" variable, so this window points
rem the user-profile folders at agents\gemini\home instead. agy then
rem keeps ~\.gemini (settings, sessions, logs) inside .Allinone.
rem Nothing outside this window is changed.
rem
rem Exception: the Google sign-in token is stored in Windows Credential
rem Manager, which does not follow these folders.
rem
rem   gemini.cmd            open agy
rem   gemini.cmd <args>     any other agy command, e.g. -p "task"
rem ---------------------------------------------------------------

call "%~dp0_env.cmd"

set "AGY_DIR=%AIO_MCP%\agents\gemini"
set "AGY_HOME=%AGY_DIR%\home"
set "USERPROFILE=%AGY_HOME%"
set "HOME=%AGY_HOME%"
set "LOCALAPPDATA=%AGY_HOME%\AppData\Local"
set "APPDATA=%AGY_HOME%\AppData\Roaming"
set "TEMP=%AGY_HOME%\tmp"
set "TMP=%AGY_HOME%\tmp"
for %%D in ("%AGY_HOME%" "%LOCALAPPDATA%" "%APPDATA%" "%TEMP%") do if not exist "%%~D" mkdir "%%~D"

title agy (.Allinone)

rem Work in the shared projects folder, not in launch\.
cd /d "%AIO_MCP%\projects"

"%AGY_DIR%\bin\agy.exe" %*

if errorlevel 1 (
  echo.
  echo [agy exited with an error. Window stays open so you can read it.]
  pause
)

endlocal
