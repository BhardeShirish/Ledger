@echo off
title Install Ootaa Ledger
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Ledger.ps1"
if errorlevel 1 (
  echo.
  echo Installation did not finish. Read the message above, then press any key.
  pause >nul
)
