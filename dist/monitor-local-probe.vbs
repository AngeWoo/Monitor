Option Explicit

Dim shell, baseDir, ps1Path, cmd
Set shell = CreateObject("WScript.Shell")

baseDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ps1Path = baseDir & "\support\monitor-local-probe-ui.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """"

shell.Run cmd, 0, False
