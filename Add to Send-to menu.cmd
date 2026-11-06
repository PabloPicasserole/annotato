@echo off
rem Adds "Annotato" to the right-click Send to menu (run once; safe to run again).
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('SendTo') + '\Annotato.lnk'); $s.TargetPath = '%~dp0Annotato.cmd'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Description = 'Open in Annotato'; $s.Save()"
if errorlevel 1 (pause) else (echo Added "Annotato" to the Send to menu.)
