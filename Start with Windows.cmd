@echo off
rem Starts Annotato quietly whenever you log in to Windows, so the Chrome extension always works. Run once; safe to run again.
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\Annotato.lnk'); $s.TargetPath = (Get-Command node).Source; $s.Arguments = '\"%~dp0server.js\" --start'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Description = 'Start Annotato'; $s.Save()"
if errorlevel 1 (pause) else (node "%~dp0server.js" --start & echo Annotato now starts with Windows, and it is running.)
