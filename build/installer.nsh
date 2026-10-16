; Feliz Cristais Gestão — ajustes do instalador (Windows)
; 1) Fecha o app antes de instalar (inclusive a versão antiga "Feliz Cristais Impressora").
; 2) Quem tinha a versão antiga instalada na pasta "...Impressora" passa para a pasta "Feliz Cristais Gestão".
; 3) Remove atalhos e pastas vazias que sobraram da versão antiga.

!ifndef BUILD_UNINSTALLER
  !include "StrFunc.nsh"
  ${StrStr}
!endif

!macro customInit
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /F /T /IM "Feliz Cristais Impressora.exe"`
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 1200
  ${StrStr} $R9 "$INSTDIR" "Impressora"
  ${If} $R9 != ""
    ${If} $hasPerMachineInstallation == "1"
      StrCpy $INSTDIR "$PROGRAMFILES64\Feliz Cristais Gestão"
    ${Else}
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Feliz Cristais Gestão"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  SetShellVarContext current
  Delete "$DESKTOP\Feliz Cristais Impressora.lnk"
  Delete "$SMPROGRAMS\Feliz Cristais Impressora.lnk"
  SetShellVarContext all
  Delete "$DESKTOP\Feliz Cristais Impressora.lnk"
  Delete "$SMPROGRAMS\Feliz Cristais Impressora.lnk"
  ; pastas antigas: só são apagadas se ficaram vazias
  RMDir "$PROGRAMFILES64\Feliz Cristais Impressora\feliz-cristais-impressora"
  RMDir "$PROGRAMFILES64\Feliz Cristais Impressora"
  RMDir "$LOCALAPPDATA\Programs\feliz-cristais-impressora"
!macroend
