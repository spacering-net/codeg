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
; writing, and a running one holds its file just the same. The cua-driver it
; runs goes with it (the driver lives in the user's cache, not here, but is
; the helper's child and has no business outliving it).
;
; Stop the companion and helper processes running from $INSTDIR before the
; installer writes new binaries (or removes the existing ones on uninstall)
; — only those: a codeg-server installed in a folder of its own runs copies
; under the same names, and they are not this installer's to stop.
; The installer finds them itself, through the Windows API: it lists the
; processes, asks each one of those names which file it runs (the answer
; does not depend on this installer's bitness), and ends those running from
; $INSTDIR, then the processes each of them started. Nothing in it waits
; without a limit: at most five seconds for each process it ends. This used
; to be PowerShell's job, through WMI, and the installer waited for
; PowerShell without a time limit: on some machines the WMI query never
; returned, and the install stood still at this step for good.
;
; In an update, the codeg that started this installer is still on its way
; out: Tauri's updater starts the installer first and exits after. Right
; after this hook, Tauri's own check has Restart Manager close whatever
; still runs codeg.exe, once, and the update stops with "Failed to kill
; codeg" if that fails, which a codeg in the middle of exiting can make it
; do (tauri-apps/tauri#16277). PowerShell's start-up used to give that codeg
; a second or so to finish; the Windows API gives it none. So an update
; first waits, for about 15 seconds at most, until codeg.exe can be written
; to, which it cannot while a codeg runs it. A codeg that takes longer is
; left to that check.
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
;
; codeg-cli.exe, the command-line client, is never stopped: a codeg-cli that
; runs is the user's own command, a review a CI job is waiting for, say. One
; in use is moved aside the same way. Its copy in bin\ is the one that goes on
; PATH (docs/cli.md): $INSTDIR itself would put codeg-mcp.exe and the rest
; there too. The copy is made after the install, from the codeg-cli.exe just
; written, and moved aside first if it is running — the copy a terminal runs.
; A copy that fails puts the moved one back: an older codeg-cli beats none.
; The uninstaller removes it after Tauri's own files, and then $INSTDIR, which
; Tauri's uninstaller could not remove with bin\ still in it. Not before
; them: the uninstaller stops when the user will not close a running codeg,
; and that codeg would be left without its command. One still running is
; renamed out of the way instead, so PATH stops finding a codeg-cli of an app
; that is gone; the next install, or the user once it ends, deletes it.

!define CODEG_TH32CS_SNAPPROCESS 0x2
; PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
!define CODEG_PROCESS_STOP_ACCESS 0x101001
; PROCESSENTRY32W as this 32-bit installer lays it out: dwSize, cntUsage,
; th32ProcessID, th32DefaultHeapID, th32ModuleID, cntThreads,
; th32ParentProcessID, pcPriClassBase, dwFlags, szExeFile.
!define CODEG_PROCESSENTRY32W "&l4, i, i, p, i, i, i, i, i, &w260"
; PROCESS_BASIC_INFORMATION, likewise: ExitStatus, PebBaseAddress,
; AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId.
!define CODEG_PROCESS_BASIC_INFORMATION "i, p, p, i, p, p"
!define CODEG_PROCESS_BASIC_INFORMATION_SIZE 24

; Ends the processes that process $3 started, $4 (this installer) aside.
; The snapshot is a moment old, and the id it gives may belong to another
; process by the time it is opened, so the process opened is asked who
; started it. $3 is still held open, so no other process can have its id
; yet; but one older than $8, when $3 started, was started by an earlier
; process under the same id, and is left alone.
!macro CODEG_STOP_CHILDREN
  System::Call 'kernel32::CreateToolhelp32Snapshot(i ${CODEG_TH32CS_SNAPPROCESS}, i 0) p .R0'
  ${If} $R0 P<> -1
    System::Call '*(${CODEG_PROCESSENTRY32W}) p .R1'
    System::Call '*(${CODEG_PROCESS_BASIC_INFORMATION}) p .R8'
    ${If} $R1 P<> 0
    ${AndIf} $R8 P<> 0
      System::Call 'kernel32::Process32FirstW(p R0, p R1) i .R2'
      ${DoWhile} $R2 <> 0
        System::Call '*$R1(i, i, i .R3, p, i, i, i .R4)'
        ${If} $R4 = $3
        ${AndIf} $R3 <> $4
          System::Call 'kernel32::OpenProcess(i ${CODEG_PROCESS_STOP_ACCESS}, i 0, i R3) p .R5'
          ${If} $R5 P<> 0
            System::Call 'ntdll::NtQueryInformationProcess(p R5, i 0, p R8, i ${CODEG_PROCESS_BASIC_INFORMATION_SIZE}, p 0) i .R7'
            ${If} $R7 = 0
              System::Call '*$R8(i, p, p, i, p, p .R4)'
              System::Call 'kernel32::GetProcessTimes(p R5, *l .R6, *l, *l, *l) i .R7'
              ${If} $R4 = $3
              ${AndIf} $R7 <> 0
              ${AndIf} $R6 L>= $8
                System::Call 'kernel32::TerminateProcess(p R5, i 1)'
                System::Call 'kernel32::WaitForSingleObject(p R5, i 5000)'
              ${EndIf}
            ${EndIf}
            System::Call 'kernel32::CloseHandle(p R5)'
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::Process32NextW(p R0, p R1) i .R2'
      ${Loop}
    ${EndIf}
    ${IfThen} $R1 P<> 0 ${|} System::Free $R1 ${|}
    ${IfThen} $R8 P<> 0 ${|} System::Free $R8 ${|}
    System::Call 'kernel32::CloseHandle(p R0)'
  ${EndIf}
!macroend

; Ends the codeg-mcp and codeg-computer-helper processes running from
; $INSTDIR, and the processes they started.
!macro CODEG_STOP_SIDECARS
  DetailPrint "Stopping codeg-mcp and codeg-computer-helper processes running from $INSTDIR..."
  System::Call 'kernel32::GetCurrentProcessId() i .r4'
  System::Call 'kernel32::CreateToolhelp32Snapshot(i ${CODEG_TH32CS_SNAPPROCESS}, i 0) p .r0'
  ${If} $0 P<> -1
    System::Call '*(${CODEG_PROCESSENTRY32W}) p .r1'
    ${If} $1 P<> 0
      System::Call 'kernel32::Process32FirstW(p r0, p r1) i .r2'
      ${DoWhile} $2 <> 0
        System::Call '*$1(i, i, i .r3, p, i, i, i, i, i, &w260 .r5)'
        ${If} $5 == "codeg-mcp.exe"
        ${OrIf} $5 == "codeg-computer-helper.exe"
          System::Call 'kernel32::OpenProcess(i ${CODEG_PROCESS_STOP_ACCESS}, i 0, i r3) p .r6'
          ${If} $6 P<> 0
            System::Call 'kernel32::QueryFullProcessImageNameW(p r6, i 0, w .r7, *i ${NSIS_MAX_STRLEN}) i .r9'
            ${If} $9 <> 0
            ${AndIf} $7 == "$INSTDIR\$5"
              DetailPrint "Stopping $7 (process $3)"
              System::Call 'kernel32::GetProcessTimes(p r6, *l .r8, *l, *l, *l) i .r9'
              System::Call 'kernel32::TerminateProcess(p r6, i 1)'
              System::Call 'kernel32::WaitForSingleObject(p r6, i 5000)'
              ${If} $9 <> 0
                !insertmacro CODEG_STOP_CHILDREN
              ${EndIf}
            ${EndIf}
            System::Call 'kernel32::CloseHandle(p r6)'
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::Process32NextW(p r0, p r1) i .r2'
      ${Loop}
      System::Free $1
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
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
  Delete "$INSTDIR\codeg-cli.exe.*.old"
  Delete "$INSTDIR\bin\codeg-cli.exe.*.old"
!macroend

; In an update, until codeg.exe can be written to: 150 retries, 100 ms apart.
!macro CODEG_WAIT_FOR_UPDATED_APP
  ${If} $UpdateMode = 1
    !insertmacro CODEG_CAN_WRITE "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $R9 = 0
      DetailPrint "Waiting for ${MAINBINARYNAME} to exit..."
      ${For} $R7 1 150
        Sleep 100
        !insertmacro CODEG_CAN_WRITE "$INSTDIR\${MAINBINARYNAME}.exe"
        ${IfThen} $R9 = 1 ${|} ${ExitFor} ${|}
      ${Next}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CODEG_WAIT_FOR_UPDATED_APP
  !insertmacro CODEG_STOP_SIDECARS
  !insertmacro CODEG_DELETE_ASIDE
  ; codeg.exe's file is in use while codeg runs.
  !insertmacro CODEG_CAN_WRITE "$INSTDIR\${MAINBINARYNAME}.exe"
  ${If} $R9 = 1
  ${OrIf} ${Silent}
  ${OrIf} $PassiveMode = 1
    !insertmacro CODEG_MOVE_ASIDE_IF_IN_USE "codeg-mcp.exe"
    !insertmacro CODEG_MOVE_ASIDE_IF_IN_USE "codeg-computer-helper.exe"
    !insertmacro CODEG_MOVE_ASIDE_IF_IN_USE "codeg-cli.exe"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\bin"
  !insertmacro CODEG_MOVE_ASIDE_IF_IN_USE "bin\codeg-cli.exe"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\codeg-cli.exe" "$INSTDIR\bin\codeg-cli.exe"
  ${If} ${Errors}
    DetailPrint "Could not copy codeg-cli.exe into $INSTDIR\bin"
    ; $R9 = 0 and $R8: CODEG_MOVE_ASIDE_IF_IN_USE moved it to .$R8.old.
    ${If} $R9 = 0
    ${AndIfNot} ${FileExists} "$INSTDIR\bin\codeg-cli.exe"
      Rename "$INSTDIR\bin\codeg-cli.exe.$R8.old" "$INSTDIR\bin\codeg-cli.exe"
    ${EndIf}
  ${EndIf}
  !insertmacro CODEG_DELETE_ASIDE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CODEG_STOP_SIDECARS
  !insertmacro CODEG_DELETE_ASIDE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} ${FileExists} "$INSTDIR\bin\codeg-cli.exe"
    ClearErrors
    Delete "$INSTDIR\bin\codeg-cli.exe"
    ${If} ${Errors}
      System::Call 'kernel32::GetTickCount() i .R8'
      Rename "$INSTDIR\bin\codeg-cli.exe" "$INSTDIR\bin\codeg-cli.exe.$R8.old"
    ${EndIf}
  ${EndIf}
  Delete "$INSTDIR\bin\codeg-cli.exe.*.old"
  RMDir "$INSTDIR\bin"
  RMDir "$INSTDIR"
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
