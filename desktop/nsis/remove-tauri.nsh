; A loki installed by the Tauri app's installer: close it and run its own uninstaller silently, which leaves ~/.loki
; alone, so the two never sit side by side in Add or Remove Programs.
!macro customInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\loki" "UninstallString"
  ${If} $0 != ""
    nsExec::Exec 'taskkill /IM loki.exe /F'
    ExecWait '$0 /S'
  ${EndIf}
!macroend
