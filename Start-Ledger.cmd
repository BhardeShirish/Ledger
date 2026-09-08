@echo off
title Ledger
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -KeepAlive
if errorlevel 1 (
  echo.
  echo Ledger could not start. Read the message above, then press any key.
  pause >nul
)
