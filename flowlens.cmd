@echo off
rem FlowLens launcher for Windows.
rem
rem Run FlowLens straight from a checkout - no install step, no global package:
rem
rem   .\flowlens.cmd init C:\code\my-app
rem   .\flowlens.cmd scan C:\code\my-app
rem
rem The first run installs dependencies and builds; later runs go straight
rem through. See bin\flowlens.mjs.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo FlowLens needs Node.js ^(18.18 or newer^). Install it from https://nodejs.org 1>&2
  exit /b 1
)
node "%~dp0bin\flowlens.mjs" %*
exit /b %errorlevel%
