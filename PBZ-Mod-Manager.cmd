@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows_mod_manager.ps1"
set "PBZ_RESULT=%ERRORLEVEL%"
if not "%PBZ_RESULT%"=="0" pause
exit /b %PBZ_RESULT%
