@echo off
rem ---------------------------------------------------------------
rem Shared environment for every launcher in this folder.
rem Called by the per-agent launchers; not meant to be run directly.
rem Everything set here lives only inside the calling window.
rem ---------------------------------------------------------------

for %%I in ("%~dp0..") do set "AIO_MCP=%%~fI"
for %%I in ("%AIO_MCP%\..") do set "AIO_ROOT=%%~fI"

rem Portable Node.js (used by dsh and the dispatcher; Codex does not need it).
set "AIO_NODE=%AIO_MCP%\runtime\node"
set "PATH=%AIO_NODE%;%PATH%"

rem Keep npm's cache and global installs inside .Allinone instead of AppData.
set "NPM_CONFIG_CACHE=%AIO_MCP%\runtime\npm-cache"
set "NPM_CONFIG_PREFIX=%AIO_MCP%\runtime\npm-global"
set "NPM_CONFIG_UPDATE_NOTIFIER=false"
rem Use an npmrc inside .Allinone so the user-level %USERPROFILE%\.npmrc is neither read nor written.
set "NPM_CONFIG_USERCONFIG=%AIO_MCP%\runtime\npmrc"
