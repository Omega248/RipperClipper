@echo off
REM Double-click me when playback is bad. Writes _diagnose.log.
REM
REM Runs the app's OWN decode code against the POVs in your newest project:
REM which decode chain this machine really uses, which rendition each tile
REM size pulls, and how many frames per second actually come out at each size.
REM That is the difference between "it's not smooth" and knowing why.
REM
REM Optional: point it at something specific.
REM   _diagnose.bat --project "C:\path\to\Event.cookieclip"
REM   _diagnose.bat --url https://kick.com/someone/videos/...
cd /d "%~dp0"
title Ripper Clipper - diagnose
echo Measuring decode, playback and how wide a 1080p60 wall this machine can go.
echo Around five minutes — the wall test decodes sixteen angles at once.
echo Output: _diagnose.log
echo.

node --experimental-transform-types --import ./scripts/sandbox-loader.mjs scripts/diagnose.mts %* > _diagnose.log 2>&1
echo DIAGNOSE_EXIT=%errorlevel% >> _diagnose.log

echo.
echo Finished. Tell Claude and it will read _diagnose.log
pause
