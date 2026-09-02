@echo off
title Ootaa Ledger - create a package
echo.
echo   What do you want to build?
echo.
echo     1  Update an existing PC        (program only, keeps its records)
echo     2  Fresh install on a new PC    (empty ledger, no records)
echo     3  Move this PC to a new one    (carries records - stops Ledger here)
echo.
choice /c 123 /n /m "Type 1, 2 or 3: "
if errorlevel 3 goto transfer
if errorlevel 2 goto fresh
set SWITCH=-Update
goto run
:fresh
set SWITCH=-Fresh
goto run
:transfer
set SWITCH=
:run
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Create-Ledger-New-PC-Package.ps1" %SWITCH%
echo.
pause
