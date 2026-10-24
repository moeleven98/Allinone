@echo off
rem Command-line entry, e.g.:
rem   aio quota
rem   aio route code
rem   aio dispatch longtext "summarise ..."
rem   aio board routing 5
rem Keep this file ASCII-only.
setlocal
chcp 65001 >nul
call "%~dp0_env.cmd"
"%AIO_NODE%\node.exe" "%AIO_MCP%\protocol\hub\aio.mjs" %*
endlocal
