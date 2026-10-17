; Tauri NSIS installer hooks.
;
; codeg-mcp.exe is the MCP stdio companion spawned by each agent CLI
; (claude / codex / opencode / ...), which is itself a grandchild of
; codeg.exe. Windows does not propagate parent death to descendants the
; way Unix does, so stale codeg-mcp.exe processes from a previous session
; can keep the binary file locked. The installer then fails to overwrite
; it with:
;
;     Error opening file for writing: ...\codeg\codeg-mcp.exe
;
; codeg-computer-helper.exe, the computer-use helper, is codeg's own child
; and exits when codeg does — but not necessarily before the updater starts
; writing, and a running one holds its file just the same. `/T` takes the
; cua-driver it runs with it (the driver lives in the user's cache, not here,
; but is the helper's child and has no business outliving it).
;
; Stop the companion and helper processes running from $INSTDIR before the
; installer writes new binaries (or removes the existing ones on uninstall)
; — only those: a codeg-server installed in a folder of its own runs copies
; under the same names, and they are not this installer's to stop.
; PowerShell finds them by path (CIM reports a process's path whatever this
; installer's bitness), and the folder reaches it in an environment
; variable, never inside the command, so no character in it can change what
; runs. If PowerShell cannot do that, every process of those names is
; stopped, as before: one left running keeps its file locked. taskkill
; returns non-zero when no processes match, which is fine — we ignore the
; result.
;
; Stopping them is not always enough: whatever starts a companion — an agent,
; or a codeg still running — can start one again before the installer
; reaches the file, and a process this installer is not allowed to stop holds
; the file all the same. But Windows lets the file of a running executable be
; renamed.
; So a sidecar whose file is still in use once the processes were stopped is
; moved aside, to its own name plus `.<n>.old` in the same folder: whatever
; runs it carries on, and the installer writes the new binary under the old
; name. The aside files are deleted after the install, or by the next install
; or uninstall, once nothing runs them any more.
;
; Not, though, when an interactive install is about to ask whether to close a
; running codeg: on a no it stops there, and that codeg would be left without
; its companion. Silent and passive installs, the updater's included, close it
; without asking. An install stopped later on, at some other file, leaves a
; moved file where it is; the next install deletes it and writes the new one.

!macro CODEG_STOP_SIDECARS
  DetailPrint "Stopping codeg-mcp and codeg-computer-helper processes running from $INSTDIR..."
  System::Call 'kernel32::SetEnvironmentVariable(t "CODEG_INSTDIR", t "$INSTDIR")'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'Stop'; $$dir = $$env:CODEG_INSTDIR.TrimEnd('\') + '\'; Get-CimInstance Win32_Process | Where-Object { ($$_.Name -eq 'codeg-mcp.exe' -or $$_.Name -eq 'codeg-computer-helper.exe') -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { & taskkill.exe /F /T /PID $$_.ProcessId | Out-Null }; exit 0"`
  Pop $0
  ${If} $0 != "0"
    nsExec::Exec 'taskkill /F /T /IM codeg-mcp.exe'
    Pop $0
    nsExec::Exec 'taskkill /F /T /IM codeg-computer-helper.exe'
    Pop $0
  ${EndIf}
  ; Small grace period so the OS releases file handles before the
  ; installer attempts to overwrite the binaries.
  Sleep 500
!macroend

; $R9 = 1 when `path` can be opened for writing, as `File` will have to open
; it, else 0. A running executable's file cannot be; a missing one counts as
; writable.
!macro CODEG_CAN_WRITE path
  StrCpy $R9 1
  ${If} ${FileExists} "${path}"
    ClearErrors
    FileOpen $R8 "${path}" a
    ${If} ${Errors}
      StrCpy $R9 0
    ${Else}
      FileClose $R8
    ${EndIf}
  ${EndIf}
!macroend

!macro CODEG_MOVE_ASIDE_IF_IN_USE name
  !insertmacro CODEG_CAN_WRITE "$INSTDIR\${name}"
  ${If} $R9 = 0
    System::Call 'kernel32::GetTickCount() i .R8'
    DetailPrint "$INSTDIR\${name} is still in use, moving it aside..."
    Rename "$INSTDIR\${name}" "$INSTDIR\${name}.$R8.old"
  ${EndIf}
!macroend

!macro CODEG_DELETE_ASIDE
  Delete "$INSTDIR\codeg-mcp.exe.*.old"
  Delete "$INSTDIR\codeg-computer-helper.exe.*.old"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CODEG_STOP_SIDECARS
  !insertmacro CODEG_DELETE_ASIDE
  ; codeg.exe's file is in use while codeg runs.
  !insertmacro CODEG_CAN_WRITE "$INSTDIR\${MAINBINARYNAME}.exe"
  ${If} $R9 = 1
  ${OrIf} ${Silent}
  ${OrIf} $PassiveMode = 1
    !insertmacro CODEG_MOVE_ASIDE_IF_IN_USE "codeg-mcp.exe"
    !insertmacro CODEG_MOVE_ASIDE_IF_IN_USE "codeg-computer-helper.exe"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro CODEG_DELETE_ASIDE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CODEG_STOP_SIDECARS
  !insertmacro CODEG_DELETE_ASIDE
!macroend

; Deliberately NOT cleaning up the "launch at login" HKCU Run values here.
; Tauri's installer template inserts NSIS_HOOK_PREUNINSTALL unconditionally at
; the top of `Section Uninstall`, and an upgrading install runs the *previous*
; version's uninstaller (`ExecWait` in the `reinst_uninstall` branch) — so a
; DeleteRegValue in this hook would silently turn launch-at-login off on every
; update, not just on a real uninstall. `$UpdateMode` only distinguishes the two
; when the in-app updater drove it; a manually re-run installer looks like a
; plain uninstall. Leaving a stale Run value behind after an uninstall is
; cosmetic (Windows ignores an entry whose target is gone), so it wins over
; losing the user's setting on upgrade.
