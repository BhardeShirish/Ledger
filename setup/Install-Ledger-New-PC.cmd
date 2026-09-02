@echo off
title Move Ootaa Ledger to this PC
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Ledger-New-PC.ps1"
if errorlevel 1 (
  echo.
  echo Installation did not finish. Read the message above, then press any key.
  pause >nul
)
