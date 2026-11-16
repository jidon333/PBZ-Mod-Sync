@echo off
setlocal
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
cd /d "%~dp0"
if not exist "..\.local\build" mkdir "..\.local\build"
ml64 /nologo /c /Fo"..\.local\build\forward.obj" forward.asm
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /MT /LD /W4 /Fo"..\.local\build\loader.obj" loader.cpp "..\.local\build\forward.obj" /link /DEF:exports.def /OUT:"..\.local\build\hid.dll" /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT
exit /b %errorlevel%
