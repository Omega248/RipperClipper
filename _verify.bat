@echo off
REM Double-click me. Runs the repo checks and appends to _verify.log.
REM Each exit code is captured immediately after its command, outside any
REM parenthesised block: %errorlevel% inside a block expands when the block is
REM PARSED, not when it runs, so a previous version reported 0 for a run that
REM had actually failed.
cd /d "%~dp0"
title Ripper Clipper - verify
echo Running typecheck, tests and build. A few minutes. Output: _verify.log

echo === node/npm === > _verify.log
call node -v >> _verify.log 2>&1
call npm -v >> _verify.log 2>&1

echo. >> _verify.log
echo === npm run typecheck === >> _verify.log
call npm run typecheck >> _verify.log 2>&1
echo TYPECHECK_EXIT=%errorlevel% >> _verify.log

echo. >> _verify.log
echo === npm test === >> _verify.log
call npm test >> _verify.log 2>&1
echo TEST_EXIT=%errorlevel% >> _verify.log

echo. >> _verify.log
echo === npm run build === >> _verify.log
call npm run build >> _verify.log 2>&1
echo BUILD_EXIT=%errorlevel% >> _verify.log

echo ALL_DONE >> _verify.log
echo.
echo Finished. Tell Claude and it will read _verify.log
pause
