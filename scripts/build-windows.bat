@echo off
rem Builds the pgsql-erd Windows executables with electron-builder.
rem
rem Usage: scripts\build-windows.bat [target] [options]
rem
rem   target (default: all)
rem     all        installer + portable
rem     installer  dist\pgsql-erd-Setup-<version>.exe    (NSIS installer, registers .pgerd)
rem     portable   dist\pgsql-erd-<version>-portable.exe (single .exe, no install)
rem     dir        dist\win-unpacked\pgsql-erd.exe       (unpacked app, fastest to build)
rem
rem   options
rem     --skip-tests    do not run npm test
rem     --skip-install  do not run npm ci
rem     --clean         delete dist\ first

setlocal EnableExtensions
cd /d "%~dp0.."

set "TARGET=all"
set "SKIP_TESTS="
set "SKIP_INSTALL="
set "CLEAN="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="all"            (set "TARGET=all"       & shift & goto parse)
if /i "%~1"=="installer"      (set "TARGET=installer" & shift & goto parse)
if /i "%~1"=="portable"       (set "TARGET=portable"  & shift & goto parse)
if /i "%~1"=="dir"            (set "TARGET=dir"       & shift & goto parse)
if /i "%~1"=="--skip-tests"   (set "SKIP_TESTS=1"     & shift & goto parse)
if /i "%~1"=="--skip-install" (set "SKIP_INSTALL=1"   & shift & goto parse)
if /i "%~1"=="--clean"        (set "CLEAN=1"          & shift & goto parse)
if /i "%~1"=="--help"         goto usage
if /i "%~1"=="-h"             goto usage
if /i "%~1"=="/?"             goto usage
echo Unknown argument: %~1
goto usage_error
:parsed

if /i "%TARGET%"=="all"       set "SCRIPT=dist:win"
if /i "%TARGET%"=="installer" set "SCRIPT=dist:win:installer"
if /i "%TARGET%"=="portable"  set "SCRIPT=dist:win:portable"
if /i "%TARGET%"=="dir"       set "SCRIPT=dist:win:dir"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js 20 or newer from https://nodejs.org/
  exit /b 1
)
set "NODE_MAJOR=0"
for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or newer is required.
  node --version
  exit /b 1
)

if defined CLEAN if exist dist (
  echo ==^> Removing dist
  rmdir /s /q dist
)

if not defined SKIP_INSTALL (
  echo ==^> Installing dependencies
  call npm ci
  if errorlevel 1 goto failed
)

if not defined SKIP_TESTS (
  echo ==^> Running tests
  call npm test
  if errorlevel 1 goto failed
)

echo ==^> Building %TARGET%
call npm run %SCRIPT%
if errorlevel 1 goto failed

echo.
echo Built:
for %%F in (dist\*.exe) do echo   %%~fF
if exist dist\win-unpacked\pgsql-erd.exe echo   %CD%\dist\win-unpacked\pgsql-erd.exe
exit /b 0

:failed
echo.
echo Build failed.
exit /b 1

:usage
echo Usage: %~nx0 [all^|installer^|portable^|dir] [--skip-tests] [--skip-install] [--clean]
exit /b 0

:usage_error
echo Usage: %~nx0 [all^|installer^|portable^|dir] [--skip-tests] [--skip-install] [--clean]
exit /b 2
