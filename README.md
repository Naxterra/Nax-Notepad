# Nax-Notepad

A fast, tabbed text editor for Windows with Obsidian-style **Markdown Live Preview** and support
for **multi-gigabyte files**. Built with Tauri 2 (Rust shell, WebView2) and CodeMirror 6.

## Features

- **Modern interface**: a frameless window with its own title bar and a command search box (it runs commands and finds text), a deep navy default theme with a matching light theme, tabs with file-type icons, and a toolbar per document with a clickable path, the **Text, Hex and Split** switch, "Decode as" and a read-only switch.
- **Split view and inspector**: Split shows the text and its bytes side by side, and selecting either one selects the other. The inspector beside the bytes shows the selection (offsets, length, the bytes as text, the value at the cursor as signed and unsigned integers and floats in both byte orders) and the file (size, type recognized from the first bytes, access, encoding, line endings), with quick actions to copy as hex or text, go to an offset or find a byte pattern.

- **Tabs** with drag-to-reorder, pin, middle-click close, context menu.
- **Session restore**: every open tab, including unsaved text, comes back after a restart or
  crash. Unsaved buffers are written to `%APPDATA%\Nax-Notepad\buffers` as you type.
- **Markdown Live Preview**: headings, bold/italic, code, lists, checkboxes, links, images,
  quotes and rules render in place; the raw syntax shows only on the line the cursor is on.
  Toggle per tab with `Ctrl+Shift+V`.
- **Huge files**: files above 48 MB are memory-mapped and edited in pages (a piece table in
  Rust). Opening, searching and saving a 2.5 GB file works without loading it into memory.
  UTF-8 files are editable; large UTF-16 and legacy code-page files are shown decoded and
  read-only. Search and Replace All see the whole logical document, and Replace All stores only
  the replacement text.
- **Find / Replace** with regex, whole word, case, in-selection, count, and **Find in Files**.
  "In selection only" captures the selection once and keeps that range through every replace.
  Replacement syntax is JavaScript's (`$&`, `$1`, `$<name>`, `$$`) for files of any size.
  **Find All** in the current document or in all open tabs, a **live line filter**
  (`Ctrl+Alt+L`) that keeps updating while a log grows, search and replace history, and a
  Cancel button for long searches. Find in Files searches files of any size (large UTF-8 files
  through a memory map) and lists every file it skipped, with the reason.
- **Safe saving**: every save writes a uniquely named temporary file and replaces the target
  only when that succeeded. Typing during a save keeps the tab dirty. Saving in a code page
  that cannot represent some characters asks first. A large file changed by another program
  is never overwritten silently. Closing waits until unsaved text is stored for recovery and
  asks what to do if that fails. Read-only mode applies to every command.
- **Syntax highlighting** for ~150 languages (from `@codemirror/language-data`), picked by file
  name or manually from the status bar.
- **Themes**: Nax Dark/Light, One Dark, Monokai, Dracula, Solarized Light, GitHub Light, or
  follow the Windows dark/light setting.
- Encoding (UTF-8, UTF-16, Windows code pages...) and line-ending detection and conversion.
- Command palette (`Ctrl+Shift+P`), go to line, multi-cursor, code folding, bracket matching,
  indentation guides, word wrap, zoom, sort/dedupe/case-change line tools.
- Single instance: opening another file from Explorer adds a tab to the running window.

### Notepad++ workflow

- **Keyboard**: an optional Notepad++ key preset (`Ctrl+L` cut line, `Ctrl+Shift+L` delete
  line, `Ctrl+Q` comment, `Ctrl+B` matching brace, `Ctrl+Shift+Up/Down` move line, ...) and a
  shortcut editor that shows conflicts. Column selection with `Alt+Shift+Arrows` or Alt+drag.
- **Bookmarks** (`Ctrl+F2`, `F2`, `Shift+F2`) that follow edits and are kept in the session;
  copy or remove the bookmarked lines.
- **Recent files**, and **Reopen Closed Tab** (`Ctrl+Shift+T`), also for unsaved new tabs.
- **Split view**: move or clone a tab to a second view; a clone shows the same document and
  edits appear in both. Synchronized scrolling and a **Compare** of the two views with next /
  previous difference.
- **Macros**: record (`Ctrl+Shift+R`), run, run N times or to the end of the file, save under a
  name and give it a key. Replays go through the editor's own key handling, so undo and
  read-only mode apply.
- **Navigation**: folder workspace sidebar (`Ctrl+Shift+E`), function list (functions, classes,
  Markdown headings), indentation detected per file, show whitespace and line endings.
- **Logs**: **Follow (tail -f)** a file with pause/resume. Appended lines are read
  incrementally, rotated or replaced files are reloaded, and following pauses while the tab has
  unsaved edits. Works for multi-gigabyte files too.
- **Encoding**: "Reopen with Encoding" (decode the file again) is separate from "Convert to
  Encoding" (write the text in another encoding on the next save).
- **Migration**: import a reviewed subset of Notepad++ settings, shortcuts, macros and the
  session (including unsaved "new" documents); only ticked items are applied and everything that
  cannot be mapped is listed. Settings export/import, and a **portable** package (settings in a
  `data` folder next to the program).
- Markdown formatting menu with shortcuts (bold `Ctrl+B`, italic `Ctrl+I`, headings `Ctrl+Alt+1..6`,
  lists `Ctrl+Shift+7/8/9`, link `Ctrl+K`, code block `Ctrl+Alt+C`, table, rule). Typing ``` opens
  a language picker (bash, sql, python, powershell, ...) that also adds the closing fence. All common Markdown
  extensions (.md, .markdown, .mdown, .mkd, .mdx, .rmd, ...) open as Markdown.
- **Hex editor** (`Ctrl+Shift+H`) for any tab, including multi-gigabyte files. Type hex digits or characters to change bytes, use Insert to switch between overwrite and insert, and use Delete, Backspace, Ctrl+C/X/V, Ctrl+Z/Y, go to offset and Ctrl+S. Files up to 8 MB can grow and shrink; larger files are edited by overwriting bytes and saved by streaming the file through a temporary copy. While the hex view is shown, the hidden text cannot be changed, and a file changed by another program is never overwritten.
- English and German UI, following the Windows language by default.
- About dialog with links to this repository and a **Check for updates** that reads the latest
  GitHub release (also runs silently once a day; can be disabled in Settings).
- Settings dialog (`Ctrl+,`), stored in `%APPDATA%\Nax-Notepad\settings.json`.
- Installer: Inno Setup wizard with a chooseable folder, per-user or all-users install, optional
  Explorer context menu, file associations and PATH entry; uninstall offers to remove user data.

## Build

Prerequisites (machine-wide, via winget): Node.js, Rust (`Rustlang.Rustup`), Visual Studio
Build Tools with the C++ workload, Inno Setup 7 (`JRSoftware.InnoSetup.7`). WebView2 is part of
Windows 11.

```powershell
npm install
npm run tauri dev          # run in development mode
npm test                   # frontend regression tests
npm run test:rust          # backend tests (piece table, encodings, saving)
powershell -File build.ps1 # release build, portable zip + installer in .\artifacts
```

## Layout

- `src-tauri/src/paged.rs` – memory-mapped document with a piece table and sparse line index.
- `src-tauri/src/textfmt.rs` – encoding / BOM / line-ending detection and conversion.
- `src-tauri/src/session.rs` – session, buffers and settings under `%APPDATA%\Nax-Notepad`.
- `src-tauri/src/lib.rs` – Tauri commands and app setup.
- `src/app.ts` – tabs, the two editor panes, open/save, follow mode, session restore.
- `src/commands.ts`, `src/keymap.ts` – commands, key presets, key dispatch, macro recorder.
- `src/macros.ts`, `src/bookmarks.ts`, `src/columnselect.ts`, `src/diff.ts`, `src/compare.ts`,
  `src/symbols.ts`, `src/indentdetect.ts`, `src/whitespace.ts` – editor features.
- `src/nppimport.ts` – Notepad++ config, session and shortcut parser.
- `src/livepreview.ts` – the Markdown Live Preview extension.
- `src/paged.ts` – windowed editing of paged documents.
- `src/ui/*` – tab bar, status bar, find panel, menus, dialogs, settings.
- `installer/Nax-Notepad.iss` – Inno Setup script.
