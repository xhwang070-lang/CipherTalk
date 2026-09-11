@echo off
cd /d "%~dp0"
echo Fast packing Huaji...
call npm run pack:win
echo.
pause
