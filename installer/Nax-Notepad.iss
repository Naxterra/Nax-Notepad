; Inno Setup 7 script for Nax-Notepad.
; Build with: powershell -File build.ps1   (compiles the app, then runs ISCC on this file)

#ifndef AppVersion
  #define AppVersion "0.5.3"
#endif
#ifndef SourceExe
  #define SourceExe "..\src-tauri\target\release\nax-notepad.exe"
#endif
#define AppUrl "https://github.com/Naxterra/Nax-Notepad"

[Setup]
AppId={{7C1E7E3B-4C7B-4E3A-9D0F-7A1E5D2C9B10}
AppName=Nax-Notepad
AppVersion={#AppVersion}
AppVerName=Nax-Notepad {#AppVersion}
AppPublisher=Naxterra
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Nax-Notepad Setup
DefaultDirName={autopf}\Nax-Notepad
DefaultGroupName=Nax-Notepad
UsePreviousAppDir=yes
DisableDirPage=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
LicenseFile=..\LICENSE
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\nax-notepad.exe
UninstallDisplayName=Nax-Notepad
OutputDir=..\artifacts
OutputBaseFilename=Nax-Notepad-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Per-user by default (no UAC); the dialog lets the user pick "all users" instead.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ChangesAssociations=yes
; Tell running programs about the PATH entry that is added on install and removed on uninstall.
ChangesEnvironment=yes
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=auto

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"

[CustomMessages]
english.ContextMenu=Add "Open with Nax-Notepad" to the Explorer context menu
german.ContextMenu="Mit Nax-Notepad öffnen" zum Explorer-Kontextmenü hinzufügen
english.Integration=Integration:
german.Integration=Integration:
english.Assoc=File associations:
german.Assoc=Dateizuordnungen:
english.AssocTxt=Offer Nax-Notepad under "Open with" for .txt files
german.AssocTxt=Nax-Notepad unter "Öffnen mit" für .txt-Dateien anbieten
english.AssocMd=Offer Nax-Notepad under "Open with" for Markdown files (.md, .markdown)
german.AssocMd=Nax-Notepad unter "Öffnen mit" für Markdown-Dateien (.md, .markdown) anbieten
english.AssocLog=Offer Nax-Notepad under "Open with" for .log files
german.AssocLog=Nax-Notepad unter "Öffnen mit" für .log-Dateien anbieten
english.AddToPath=Add the installation folder to the user PATH
german.AddToPath=Installationsordner zum Benutzer-PATH hinzufügen
english.RemoveData=Also remove settings, session, unsaved text and the window position (%APPDATA%\Nax-Notepad)?
german.RemoveData=Auch Einstellungen, Sitzung, ungespeicherten Text und die Fensterposition (%APPDATA%\Nax-Notepad) entfernen?

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "contextmenu"; Description: "{cm:ContextMenu}"; GroupDescription: "{cm:Integration}"
Name: "addtopath"; Description: "{cm:AddToPath}"; GroupDescription: "{cm:Integration}"; Flags: unchecked
Name: "assoc_txt"; Description: "{cm:AssocTxt}"; GroupDescription: "{cm:Assoc}"; Flags: unchecked
Name: "assoc_md"; Description: "{cm:AssocMd}"; GroupDescription: "{cm:Assoc}"; Flags: unchecked
Name: "assoc_log"; Description: "{cm:AssocLog}"; GroupDescription: "{cm:Assoc}"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Nax-Notepad"; Filename: "{app}\nax-notepad.exe"
Name: "{group}\Nax-Notepad on GitHub"; Filename: "{#AppUrl}"
Name: "{autodesktop}\Nax-Notepad"; Filename: "{app}\nax-notepad.exe"; Tasks: desktopicon

[Registry]
; App Paths entry so "nax-notepad" works from Run and the command line
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\nax-notepad.exe"; ValueType: string; ValueName: ""; ValueData: "{app}\nax-notepad.exe"; Flags: uninsdeletekey
; Explorer context menu for every file
Root: HKA; Subkey: "Software\Classes\*\shell\Nax-Notepad"; ValueType: string; ValueName: ""; ValueData: "Open with Nax-Notepad"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\*\shell\Nax-Notepad"; ValueType: string; ValueName: "Icon"; ValueData: """{app}\nax-notepad.exe"""; Tasks: contextmenu
Root: HKA; Subkey: "Software\Classes\*\shell\Nax-Notepad\command"; ValueType: string; ValueName: ""; ValueData: """{app}\nax-notepad.exe"" ""%1"""; Tasks: contextmenu
; ProgID used by the optional associations
Root: HKA; Subkey: "Software\Classes\NaxNotepad.Document"; ValueType: string; ValueName: ""; ValueData: "Text Document"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\NaxNotepad.Document\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\nax-notepad.exe"",0"
Root: HKA; Subkey: "Software\Classes\NaxNotepad.Document\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\nax-notepad.exe"" ""%1"""
; The default program for a file type stays the user's choice (Windows asks or Settings > Default
; apps); the installer only adds Nax-Notepad to the "Open with" list and removes it again.
Root: HKA; Subkey: "Software\Classes\.txt\OpenWithProgids"; ValueType: string; ValueName: "NaxNotepad.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc_txt
Root: HKA; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "NaxNotepad.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc_md
Root: HKA; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: string; ValueName: "NaxNotepad.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc_md
Root: HKA; Subkey: "Software\Classes\.log\OpenWithProgids"; ValueType: string; ValueName: "NaxNotepad.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc_log
; Register as an "Open with" candidate for text-like files
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "Nax-Notepad"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\nax-notepad.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".txt"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".markdown"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".log"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".json"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".xml"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".csv"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".ini"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".ps1"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".py"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".sql"; ValueData: ""
; Optional PATH entry (user scope)
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath(ExpandConstant('{app}'))

[Run]
Filename: "{app}\nax-notepad.exe"; Description: "{cm:LaunchProgram,Nax-Notepad}"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

{ Remove every entry that is exactly Dir from a ';'-separated path list. }
function WithoutPathEntry(List, Dir: string): string;
var
  Rest, Part: string;
  P: Integer;
begin
  Result := '';
  Rest := List;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Part := Rest;
      Rest := '';
    end
    else
    begin
      Part := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end;
    if (Part <> '') and (CompareText(RemoveBackslashUnlessRoot(Part), RemoveBackslashUnlessRoot(Dir)) <> 0) then
    begin
      if Result <> '' then
        Result := Result + ';';
      Result := Result + Part;
    end;
  end;
end;

procedure RemoveFromUserPath(Dir: string);
var
  OldPath, NewPath: string;
begin
  if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OldPath) then
  begin
    NewPath := WithoutPathEntry(OldPath, Dir);
    if NewPath <> OldPath then
      RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath);
  end;
end;

{ Versions up to 0.5.2 made Nax-Notepad the default program by pointing the extension at its
  ProgID. That ProgID is removed on uninstall, so such a pointer is removed too. }
procedure RemoveOldDefault(Ext: string);
var
  Value: string;
begin
  if RegQueryStringValue(HKA, 'Software\Classes\' + Ext, '', Value) and (CompareText(Value, 'NaxNotepad.Document') = 0) then
    RegDeleteValue(HKA, 'Software\Classes\' + Ext, '');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RemoveOldDefault('.txt');
    RemoveOldDefault('.md');
    RemoveOldDefault('.markdown');
    RemoveOldDefault('.log');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    RemoveFromUserPath(ExpandConstant('{app}'));
    RemoveOldDefault('.txt');
    RemoveOldDefault('.md');
    RemoveOldDefault('.markdown');
    RemoveOldDefault('.log');
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    // The browser engine's cache belongs to the program, not to the user.
    DelTree(ExpandConstant('{localappdata}\com.nax.notepad'), True, True, True);
    DataDir := ExpandConstant('{userappdata}\Nax-Notepad');
    if DirExists(DataDir) or DirExists(ExpandConstant('{userappdata}\com.nax.notepad')) then
      if SuppressibleMsgBox(ExpandConstant('{cm:RemoveData}'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      begin
        DelTree(DataDir, True, True, True);
        DelTree(ExpandConstant('{userappdata}\com.nax.notepad'), True, True, True);
      end;
  end;
end;
