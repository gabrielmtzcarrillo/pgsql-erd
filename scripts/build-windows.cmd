@echo off
rem Builds the pgsql-erd Windows executables. Arguments are passed to
rem build-windows.ps1, e.g.:  scripts\build-windows.cmd -Target portable
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
exit /b %ERRORLEVEL%
