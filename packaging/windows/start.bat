@echo off
REM Starts OSC Web Mixer and restarts it if it stops.
cd /d "%~dp0"
:loop
OSCWebMixer2.exe
echo %date% %time% OSCWebMixer2 exited with code %errorlevel%, restarting in 3 s>>restarts.log
timeout /t 3 /nobreak >nul
goto loop
