Option Explicit

Dim shell, fso
Dim baseDir, ps1Path, commandLine

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = baseDir & "\monitor-local-probe-ui.ps1"

Function Quote(ByVal value)
  Quote = """" & value & """"
End Function

If fso.FileExists(ps1Path) Then
  commandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(ps1Path)
  shell.Run commandLine, 0, False
End If
