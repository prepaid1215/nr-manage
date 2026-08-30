Set shell = CreateObject("WScript.Shell")
exeDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = exeDir
shell.Run """" & exeDir & "\NRCSync.exe""", 0, False
