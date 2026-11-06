@echo off
rem Adds "Review a mock" to the right-click Send to menu (run once; safe to run again).
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('SendTo') + '\Review a mock.lnk'); $s.TargetPath = '%~dp0Review a mock.cmd'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Description = 'Open in Canvas feedback'; $s.Save()"
if errorlevel 1 (pause) else (echo Added "Review a mock" to the Send to menu.)
