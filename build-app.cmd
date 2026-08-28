@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0build-app.ps1" %*
