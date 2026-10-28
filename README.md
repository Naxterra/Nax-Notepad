# Nax-Notepad

A fast, tabbed text editor for Windows with Obsidian-style **Markdown Live Preview** and support for **multi-gigabyte files**. Built with Tauri 2 (Rust shell, WebView2) and CodeMirror 6.

## Features

- **Modern interface**: a frameless window with its own title bar and a command search box (it runs commands and finds text), a deep navy default theme with a matching light theme, tabs with file-type icons, and a toolbar per document with a clickable path, the **Text, Hex and Split** switch, "Decode as" and a read-only switch.
- **Split view and inspector**: Split shows the text and its bytes side by side, and selecting either one selects the other. The inspector beside the bytes shows the selection (offsets, length, the bytes as text, the value at the cursor as signed and unsigned integers and floats in both byte orders) and the file (size, type recognized from the first bytes, access, encoding, line endings), with quick actions to copy as hex or text, go to an offset or find a byte pattern.
- **Tabs** with drag-to-reorder, pin, middle-click close and a context menu.
- **Session restore**: every open tab, including unsaved text, comes back after a restart or crash. Unsaved buffers are written to `%APPDATA%\Nax-Notepad\buffers` as you type. Tabs with unsaved text come back even when restoring all tabs is switched off in Settings.
- **Markdown Live Preview**: headings, bold and italic text, code, lists, checkboxes, links, images, quotes and rules render in place, and the raw syntax shows only on the line the cursor is on. Toggle it per tab with `Ctrl+Shift+V`. Images from the internet are loaded only when that is switched on in Settings, and images on network shares are loaded only for documents on the same share.
- **Huge files**: files above 48 MB are memory-mapped and edited in pages (a piece table in Rust). Opening, searching and saving a 2.5 GB file works without loading it into memory. UTF-8 files are editable, while large UTF-16 and legacy code-page files are shown decoded and read-only. Search and Replace All see the whole logical document, and Replace All stores only the replacement text. A file that grows beyond 48 MB while it is open is shown in pages after the next reload.
- **Find and Replace** with regular expressions, whole word, case, in-selection, count, and **Find in Files**. "In selection only" captures the selection once and keeps that range through every replace. The replacement syntax is JavaScript's (`$&`, `$1`, `$<name>`, `$$`) for files of any size. **Find All** works in the current document or in all open tabs, a **live line filter** (`Ctrl+Alt+L`) keeps updating while a log grows, search and replace keep a history, and long searches have a Cancel button. Find in Files searches files of any size (large UTF-8 files through a memory map) and lists every file it skipped, with the reason.
- **Safe saving**: every save writes a uniquely named temporary file and replaces the target only when that succeeded. The replacement keeps the file's hidden and system attributes, a symbolic link stays a link and the file it points to is updated, and a file with several hard links is rewritten in place so every name sees the new text. If the app or the computer stops in the middle of such a rewrite, the save is finished at the next start and the app says so. A file that another program changed after it was opened is never overwritten silently, whatever its size. Typing during a save keeps the tab dirty. Saving in a code page that cannot represent some characters asks first. Recovery data that is written late, after the save already finished, is discarded instead of bringing old text back. Closing waits until unsaved text is stored for recovery and asks what to do if that fails. Read-only mode applies to every command.
- **Syntax highlighting** for about 150 languages (from `@codemirror/language-data`), picked by file name or manually from the status bar.
- **Themes**: Nax Dark and Light, One Dark, Monokai, Dracula, Solarized Light, GitHub Light, or following the Windows dark or light setting.
- Encoding (UTF-8, UTF-16, Windows code pages and more) and line-ending detection and conversion.
- Command palette (`Ctrl+Shift+P`), go to line, multiple cursors, code folding, bracket matching, indentation guides, word wrap, zoom, and line tools to sort, remove duplicates and change case.
- Single instance: opening another file from Explorer adds a tab to the running window. A portable copy runs as its own instance, only one copy runs from the same folder, and it keeps no window position outside its `data` folder.
- File names that start with a dash can be opened from the command line.

### Notepad++ workflow

- **Keyboard**: an optional Notepad++ key preset (`Ctrl+L` cut line, `Ctrl+Shift+L` delete line, `Ctrl+Q` comment, `Ctrl+B` matching brace, `Ctrl+Shift+Up/Down` move line, and more) and a shortcut editor that shows conflicts. Column selection works with `Alt+Shift+Arrows` or Alt+drag. Letter shortcuts follow the keyboard layout, so `Ctrl+A` is the key labeled A on AZERTY keyboards too.
- **Bookmarks** (`Ctrl+F2`, `F2`, `Shift+F2`) follow edits and are kept in the session, and the bookmarked lines can be copied or removed.
- **Recent files**, and **Reopen Closed Tab** (`Ctrl+Shift+T`), also for unsaved new tabs.
- **Split view**: move or clone a tab to a second view. A clone shows the same document, and edits appear in both. Scrolling can be synchronized, and **Compare** shows the differences between the two views with next and previous navigation.
- **Macros**: record (`Ctrl+Shift+R`), run, run N times or to the end of the file, save under a name and give it a key. Replays go through the editor's own key handling, so undo and read-only mode apply.
- **Navigation**: a folder workspace sidebar (`Ctrl+Shift+E`), a function list (functions, classes, Markdown headings), indentation detected per file, and showing whitespace and line endings.
- **Logs**: **Follow (tail -f)** a file with pause and resume. Appended lines are read incrementally, a character that is only partly written yet is completed on the next read, rotated or replaced files are reloaded, and following pauses while the tab has unsaved edits. This works for multi-gigabyte files too.
- **Encoding**: "Reopen with Encoding" (decode the file again) is separate from "Convert to Encoding" (write the text in another encoding on the next save).
- **Migration**: import a reviewed subset of Notepad++ settings, shortcuts, macros and the session (including unsaved "new" documents). Only ticked items are applied, and everything that cannot be mapped is listed. Settings can be exported and imported, and a **portable** package keeps its settings in a `data` folder next to the program.
- A Markdown formatting menu with shortcuts (bold `Ctrl+B`, italic `Ctrl+I`, headings `Ctrl+Alt+1..6`, lists `Ctrl+Shift+7/8/9`, link `Ctrl+K`, code block `Ctrl+Alt+C`, table, rule). Typing ``` opens a language picker (bash, sql, python, powershell and more) that also adds the closing fence. All common Markdown extensions (.md, .markdown, .mdown, .mkd, .mdx, .rmd and more) open as Markdown.
- **Hex editor** (`Ctrl+Shift+H`) for any tab, including multi-gigabyte files. Type hex digits or characters to change bytes, use Insert to switch between overwrite and insert, and use Delete, Backspace, Ctrl+C/X/V, Ctrl+Z/Y, go to offset and Ctrl+S. Files up to 8 MB can grow and shrink, and larger files are edited by overwriting bytes and saved by streaming the file through a temporary copy. While the hex view is shown, the hidden text cannot be changed, and a file changed by another program is never overwritten.
- English and German user interface, following the Windows language by default.
- An About dialog with links to this repository and a **Check for updates** that reads the latest GitHub release. The check also runs silently once a day and can be disabled in Settings.
- A Settings dialog (`Ctrl+,`), stored in `%APPDATA%\Nax-Notepad\settings.json`.
- Installer: an Inno Setup wizard with a choosable folder, per-user or all-users install, an optional Explorer context menu, "Open with" entries for text and Markdown files, and a PATH entry. The default program for a file type stays your choice in Windows. Uninstalling removes the PATH entry and the installer's registry entries, gives .txt and .log files back the Windows text file type if version 0.5.2 or older had taken them over, and offers to remove user data.

## Build

Prerequisites (machine-wide, via winget): Node.js, Rust (`Rustlang.Rustup`), Visual Studio Build Tools with the C++ workload, and Inno Setup 7 (`JRSoftware.InnoSetup.7`). WebView2 is part of Windows 11.

```powershell
npm install
npm run tauri dev          # run in development mode
npm test                   # frontend regression tests
npm run test:rust          # backend tests (piece table, encodings, saving)
powershell -File build.ps1 # release build, portable zip + installer in .\artifacts
```

The test `saving_through_a_symbolic_link_updates_the_linked_file` needs permission to create symbolic links (Windows Developer Mode) and is skipped by default. Run it with `cargo test --lib -- --ignored` on a machine that allows symbolic links.

## Layout

- `src-tauri/src/paged.rs` holds the memory-mapped document with a piece table and a sparse line index.
- `src-tauri/src/textfmt.rs` holds encoding, BOM and line-ending detection and conversion.
- `src-tauri/src/session.rs` holds the session, buffers, settings under `%APPDATA%\Nax-Notepad` and the atomic file replacement.
- `src-tauri/src/lib.rs` holds the Tauri commands and the app setup.
- `src/app.ts` holds the tabs, the two editor panes, open and save, follow mode and session restore.
- `src/commands.ts` and `src/keymap.ts` hold the commands, key presets, key dispatch and the macro recorder.
- `src/macros.ts`, `src/bookmarks.ts`, `src/columnselect.ts`, `src/diff.ts`, `src/compare.ts`, `src/symbols.ts`, `src/indentdetect.ts` and `src/whitespace.ts` hold editor features.
- `src/nppimport.ts` parses the Notepad++ configuration, session and shortcuts.
- `src/livepreview.ts` is the Markdown Live Preview extension.
- `src/paged.ts` handles windowed editing of paged documents.
- `src/ui/*` holds the tab bar, status bar, find panel, menus, dialogs and settings.
- `installer/Nax-Notepad.iss` is the Inno Setup script.
