!ifndef BUILD_UNINSTALLER
  !include "LogicLib.nsh"
  !include "nsDialogs.nsh"
  !include "MUI2.nsh"

  Var VbCableCheckbox
  Var VbCableInstall
  Var VbCableAlreadyInstalled
  Var VbCableExitCode
  Var VbCableSkipPage

  !define MUI_FINISHPAGE_TEXT_REBOOT "MicDrop and VB-CABLE are installed. Restart Windows now so the CABLE Input and CABLE Output devices become available."
  !define MUI_FINISHPAGE_TEXT_REBOOTNOW "Restart Windows now (recommended)"
  !define MUI_FINISHPAGE_TEXT_REBOOTLATER "Restart later"

  !macro customInit
    StrCpy $VbCableInstall "1"
    StrCpy $VbCableAlreadyInstalled "0"
    StrCpy $VbCableSkipPage "0"
    ${If} ${isUpdated}
      StrCpy $VbCableInstall "0"
      StrCpy $VbCableSkipPage "1"
    ${EndIf}
    ClearErrors
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMME" "ImagePath"
    ${IfNot} ${Errors}
    ${AndIf} $0 != ""
      StrCpy $VbCableInstall "0"
      StrCpy $VbCableAlreadyInstalled "1"
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    Page custom VbCablePageCreate VbCablePageLeave
  !macroend

  Function VbCablePageCreate
    ${If} $VbCableSkipPage == "1"
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Set up game audio" "Install the virtual audio device MicDrop needs"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 30u "MicDrop sends your microphone and sound clips to VB-CABLE, which games can use as one microphone input."
    Pop $0

    ${If} $VbCableAlreadyInstalled == "1"
      ${NSD_CreateCheckbox} 0 38u 100% 12u "VB-CABLE is already installed"
      Pop $VbCableCheckbox
      ${NSD_Check} $VbCableCheckbox
      EnableWindow $VbCableCheckbox 0
    ${Else}
      ${NSD_CreateCheckbox} 0 38u 100% 12u "Install VB-CABLE (recommended)"
      Pop $VbCableCheckbox
      ${NSD_Check} $VbCableCheckbox
    ${EndIf}

    ${NSD_CreateLabel} 0 58u 100% 30u "VB-CABLE is separate donationware from VB-Audio Software. By installing it, you accept VB-Audio's license. All participations are welcome."
    Pop $0

    ${NSD_CreateLink} 0 92u 100% 12u "Review VB-CABLE licensing and donation options"
    Pop $0
    ${NSD_OnClick} $0 VbCableOpenLicensing

    ${NSD_CreateLabel} 0 116u 100% 24u "After setup, restart Windows once. MicDrop will remain installed if you choose not to install VB-CABLE."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function VbCableOpenLicensing
    ExecShell "open" "https://vb-audio.com/Services/licensing.htm"
  FunctionEnd

  Function VbCablePageLeave
    ${If} $VbCableAlreadyInstalled == "1"
      StrCpy $VbCableInstall "0"
      Return
    ${EndIf}

    ${NSD_GetState} $VbCableCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $VbCableInstall "1"
    ${Else}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Without VB-CABLE, MicDrop cannot send your microphone and clips to a game's voice chat.$\r$\n$\r$\nContinue without VB-CABLE?" /SD IDYES IDYES continue_without_vbcable
      Abort
      continue_without_vbcable:
      StrCpy $VbCableInstall "0"
    ${EndIf}
  FunctionEnd

  !macro customInstall
    ${IfNot} ${isUpdated}
    ${AndIf} $VbCableInstall == "1"
      DetailPrint "Preparing the official VB-CABLE Driver Pack 45..."
      File /oname=$PLUGINSDIR\VBCABLE_Driver_Pack45.zip "${BUILD_RESOURCES_DIR}\vendor\VBCABLE_Driver_Pack45.zip"
      CreateDirectory "$PLUGINSDIR\vbcable"
      nsisunz::Unzip "$PLUGINSDIR\VBCABLE_Driver_Pack45.zip" "$PLUGINSDIR\vbcable"
      Pop $0

      ${If} $0 == "success"
        DetailPrint "Installing VB-CABLE..."
        ExecWait '"$PLUGINSDIR\vbcable\VBCABLE_Setup_x64.exe" -i -h' $VbCableExitCode
        ${If} $VbCableExitCode == 0
        ${OrIf} $VbCableExitCode == 1641
        ${OrIf} $VbCableExitCode == 3010
          SetRebootFlag true
          DetailPrint "VB-CABLE installed successfully."
        ${Else}
          MessageBox MB_OK|MB_ICONEXCLAMATION "MicDrop was installed, but VB-CABLE could not be installed automatically (error $VbCableExitCode).$\r$\n$\r$\nUse the VB-CABLE link in MicDrop's Help screen to install it manually."
        ${EndIf}
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "MicDrop was installed, but its bundled VB-CABLE package could not be unpacked.$\r$\n$\r$\nUse the VB-CABLE link in MicDrop's Help screen to install it manually."
      ${EndIf}
    ${EndIf}
  !macroend
!endif
