@echo off
title Update Ootaa Ledger on this PC
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Ledger.ps1"
if errorlevel 1 (
  echo.
  echo The update did not finish. Read the message above, then press any key.
  pause >nul
)
