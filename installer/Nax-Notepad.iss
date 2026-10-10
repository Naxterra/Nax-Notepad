; Inno Setup 7 script for Nax-Notepad.
; Build with: powershell -File build.ps1   (compiles the app, then runs ISCC on this file)

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\src-tauri\target\release\nax-notepad.exe"
#endif

[Setup]
AppId={{7C1E7E3B-4C7B-4E3A-9D0F-7A1E5D2C9B10}
AppName=Nax-Notepad
AppVersion={#AppVersion}
AppPublisher=Naxterra
DefaultDirName={autopf}\Nax-Notepad
DefaultGroupName=Nax-Notepad
UninstallDisplayIcon={app}\nax-notepad.exe
OutputDir=..\artifacts
OutputBaseFilename=Nax-Notepad-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequiredOverridesAllowed=dialog
ChangesAssociations=yes
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "contextmenu"; Description: "Add ""Open with Nax-Notepad"" to the Explorer context menu"; GroupDescription: "Integration:"
Name: "assoc_txt"; Description: "Make Nax-Notepad the default editor for .txt files"; GroupDescription: "File associations:"; Flags: unchecked
Name: "assoc_md"; Description: "Make Nax-Notepad the default editor for .md files"; GroupDescription: "File associations:"; Flags: unchecked
Name: "assoc_log"; Description: "Make Nax-Notepad the default editor for .log files"; GroupDescription: "File associations:"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Nax-Notepad"; Filename: "{app}\nax-notepad.exe"
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
Root: HKA; Subkey: "Software\Classes\.log"; ValueType: string; ValueName: ""; ValueData: "NaxNotepad.Document"; Tasks: assoc_log
; Register as an "Open with" candidate for text-like files
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "Nax-Notepad"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\nax-notepad.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".txt"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".log"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".json"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".xml"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".csv"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".ini"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".ps1"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".py"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\nax-notepad.exe\SupportedTypes"; ValueType: string; ValueName: ".sql"; ValueData: ""

[Run]
Filename: "{app}\nax-notepad.exe"; Description: "{cm:LaunchProgram,Nax-Notepad}"; Flags: nowait postinstall skipifsilent
