@echo off
rem ============================================================
rem  Sudoku launcher - opens the game in a desktop app window.
rem  Double-click this file, or use the desktop shortcut.
rem ============================================================
setlocal

set "GAME=%~dp0index.html"
if not exist "%GAME%" (
  echo [Sudoku] Game file not found:
  echo %GAME%
  pause
  exit /b 1
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

rem Build an encoded file:/// URL (handles folders with spaces)
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "([uri]'%GAME%').AbsoluteUri"`) do set "URL=%%u"
if not defined URL set "URL=file:///%GAME:\=/%"

if exist "%EDGE%" (
  start "" "%EDGE%" --app="%URL%" --window-size=1180,900
  exit /b 0
)
if exist "%CHROME%" (
  start "" "%CHROME%" --app="%URL%" --window-size=1180,900
  exit /b 0
)

rem Fallback: open with the default browser
start "" "%GAME%"
