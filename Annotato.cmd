@echo off
rem Drag an HTML file or a mock folder onto this file, or double-click it to pick one.
node "%~dp0server.js" %1
if errorlevel 1 pause
