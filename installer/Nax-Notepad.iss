; Inno Setup 7 script for Nax-Notepad.
; Build with: powershell -File build.ps1   (compiles the app, then runs ISCC on this file)

#ifndef AppVersion
  #define AppVersion "0.3.0"
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
english.AssocTxt=Make Nax-Notepad the default editor for .txt files
german.AssocTxt=Nax-Notepad als Standardeditor für .txt-Dateien festlegen
english.AssocMd=Make Nax-Notepad the default editor for Markdown files (.md, .markdown)
german.AssocMd=Nax-Notepad als Standardeditor für Markdown-Dateien (.md, .markdown) festlegen
english.AssocLog=Make Nax-Notepad the default editor for .log files
german.AssocLog=Nax-Notepad als Standardeditor für .log-Dateien festlegen
english.AddToPath=Add the installation folder to the user PATH
german.AddToPath=Installationsordner zum Benutzer-PATH hinzufügen
english.RemoveData=Also remove settings, session and unsaved text (%APPDATA%\Nax-Notepad)?
german.RemoveData=Auch Einstellungen, Sitzung und ungespeicherten Text (%APPDATA%\Nax-Notepad) entfernen?

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
Root: HKA; Subkey: "Software\Classes\.txt"; ValueType: string; ValueName: ""; ValueData: "NaxNotepad.Document"; Tasks: assoc_txt
Root: HKA; Subkey: "Software\Classes\.md"; ValueType: string; ValueName: ""; ValueData: "NaxNotepad.Document"; Tasks: assoc_md
Root: HKA; Subkey: "Software\Classes\.markdown"; ValueType: string; ValueName: ""; ValueData: "NaxNotepad.Document"; Tasks: assoc_md
Root: HKA; Subkey: "Software\Classes\.log"; ValueType: string; ValueName: ""; ValueData: "NaxNotepad.Document"; Tasks: assoc_log
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

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{userappdata}\Nax-Notepad');
    if DirExists(DataDir) then
      if MsgBox(ExpandConstant('{cm:RemoveData}'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
