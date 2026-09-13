@echo off
title Ledger - remove all local data
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Remove-Ledger-Data.ps1"
if errorlevel 1 (
  echo.
  echo Nothing was removed, or cleanup did not finish. Read the message above, then press any key.
  pause >nul
)
