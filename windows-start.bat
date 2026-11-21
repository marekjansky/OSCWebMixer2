@echo off
rem Starts OSCWebMixer2 and restarts it if node ever exits (crash, unhandled error...).
rem Every restart is appended to restarts.log next to this file. Close the window (or press Ctrl+C twice) to stop.
cd /d "%~dp0"

:loop
node .
set EXITCODE=%ERRORLEVEL%
echo [%date% %time%] node exited with code %EXITCODE%, restarting in 3 seconds>> "%~dp0restarts.log"
echo.
echo *** node exited with code %EXITCODE% at %time%. Restarting in 3 seconds (Ctrl+C to stop) ***
echo.
timeout /t 3 /nobreak >nul
goto loop
