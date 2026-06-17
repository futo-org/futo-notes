; FUTO Notes — NSIS installer hooks (Windows only).
;
; The Tauri/Rust binary links the MSVC C++ runtime, which a clean Windows
; install does NOT ship. Without it the app dies on first launch with
; "MSVCP140_1.dll was not found" (observed on a fresh Win11 VM verifying the
; v1.5.1 build). Install the bundled Microsoft Visual C++ 2015-2022 x64
; redistributable silently right after our files are laid down.
;
; vc_redist.x64.exe is declared in bundle.resources (tauri.windows.conf.json)
; and fetched at build time by ci/win-build.ps1. Tauri places bundled
; resources under $INSTDIR; check the likely locations defensively.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Ensuring the Microsoft Visual C++ runtime is installed..."
  ${If} ${FileExists} "$INSTDIR\vc_redist.x64.exe"
    ExecWait '"$INSTDIR\vc_redist.x64.exe" /install /quiet /norestart'
  ${ElseIf} ${FileExists} "$INSTDIR\resources\vc_redist.x64.exe"
    ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart'
  ${Else}
    DetailPrint "WARNING: bundled vc_redist.x64.exe not found; skipping VC++ runtime install."
  ${EndIf}
!macroend
