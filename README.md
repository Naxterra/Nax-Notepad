# Nax-Notepad

A fast, tabbed text editor for Windows with Obsidian-style **Markdown Live Preview** and support
for **multi-gigabyte files**. Built with Tauri 2 (Rust shell, WebView2) and CodeMirror 6.

## Features

- **Tabs** with drag-to-reorder, pin, middle-click close, context menu.
- **Session restore**: every open tab, including unsaved text, comes back after a restart or
  crash. Unsaved buffers are written to `%APPDATA%\Nax-Notepad\buffers` as you type.
- **Markdown Live Preview**: headings, bold/italic, code, lists, checkboxes, links, images,
  quotes and rules render in place; the raw syntax shows only on the line the cursor is on.
  Toggle per tab with `Ctrl+Shift+V`.
- **Huge files**: files above 48 MB are memory-mapped and edited in pages (a piece table in
  Rust). Opening, searching and saving a 2.5 GB file works without loading it into memory.
- **Find / Replace** with regex, whole word, case, in-selection, count, and **Find in Files**.
- **Syntax highlighting** for ~150 languages (from `@codemirror/language-data`), picked by file
  name or manually from the status bar.
- **Themes**: Nax Dark/Light, One Dark, Monokai, Dracula, Solarized Light, GitHub Light, or
  follow the Windows dark/light setting.
- Encoding (UTF-8, UTF-16, Windows code pages...) and line-ending detection and conversion.
- Command palette (`Ctrl+Shift+P`), go to line, multi-cursor, code folding, bracket matching,
  indentation guides, word wrap, zoom, sort/dedupe/case-change line tools.
- Single instance: opening another file from Explorer adds a tab to the running window.
- Markdown formatting menu with shortcuts (bold `Ctrl+B`, italic `Ctrl+I`, headings `Ctrl+Alt+1..6`,
  lists `Ctrl+Shift+7/8/9`, link `Ctrl+K`, code block `Ctrl+Alt+C`, table, rule). Typing ``` opens
  a language picker (bash, sql, python, powershell, ...) that also adds the closing fence. All common Markdown
  extensions (.md, .markdown, .mdown, .mkd, .mdx, .rmd, ...) open as Markdown.
- **Hex view** (`Ctrl+Shift+H`) for any tab, including multi-gigabyte files, with go to offset.
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
powershell -File build.ps1 # release build + installer in .\artifacts
```

## Layout

- `src-tauri/src/paged.rs` – memory-mapped document with a piece table and sparse line index.
- `src-tauri/src/textfmt.rs` – encoding / BOM / line-ending detection and conversion.
- `src-tauri/src/session.rs` – session, buffers and settings under `%APPDATA%\Nax-Notepad`.
- `src-tauri/src/lib.rs` – Tauri commands and app setup.
- `src/app.ts` – tabs, open/save, session restore.
- `src/livepreview.ts` – the Markdown Live Preview extension.
- `src/paged.ts` – windowed editing of paged documents.
- `src/ui/*` – tab bar, status bar, find panel, menus, dialogs, settings.
- `installer/Nax-Notepad.iss` – Inno Setup script.
