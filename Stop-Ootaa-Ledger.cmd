@echo off
title Ootaa Ledger - stopping
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.
pause
