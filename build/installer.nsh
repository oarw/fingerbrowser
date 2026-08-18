!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro customInit
  ; Preserve pre-0.2.1-pre.5 kernels before the old app directory is replaced.
  ${If} ${FileExists} "$INSTDIR\kernels"
    ${GetParent} "$INSTDIR" $R0
    StrCpy $R1 "$R0\FingerBrowserData"
    CreateDirectory "$R1"
    ${Unless} ${FileExists} "$R1\kernels"
      Rename "$INSTDIR\kernels" "$R1\kernels"
    ${EndUnless}
  ${EndIf}
!macroend
