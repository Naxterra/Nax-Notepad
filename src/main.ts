import { closeBrackets } from "@codemirror/autocomplete";
import { bracketMatching, syntaxTree } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { EditorView, highlightActiveLine } from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./app";
import { backend } from "./backend";
import { buildCommands, installKeybindings } from "./commands";
import { compartments, indentExt, lineNumbersExt } from "./editor";
import { loadSettings, onSettingsChange, settings, updateSettings } from "./settings";
import { applyTheme, onSystemThemeChange } from "./theme";
import { contextMenu, h, isModalOpen } from "./ui/dialogs";
import { copySelection, deleteSelection, pasteClipboard, selectAllIn } from "./clipboard";
import { redo, undo } from "@codemirror/commands";
import { t } from "./i18n";
import { initLanguage } from "./i18n";
import { openAboutDialog } from "./ui/about";
import { scheduleStartupCheck } from "./update";
import { HexView } from "./ui/hexview";
import { mountFind } from "./ui/find";
import { mountMenuBar } from "./ui/menu";
import { mountStatusBar } from "./ui/statusbar";
import { mountTabBar } from "./ui/tabbar";
import "./styles.css";

async function main(): Promise<void> {
  await loadSettings();
  initLanguage(settings.language);
  applyTheme(settings.theme);

  const root = document.getElementById("app")!;
  const menubar = h("div", { class: "menubar" });
  const tabbar = h("div", { class: "tabbar" });
  const findTop = h("div", { class: "find-top" });
  const editorEl = h("div", { class: "editor" });
  const resultsBottom = h("div", { class: "results-bottom" });
  const statusbar = h("div", { class: "statusbar" });
  root.append(menubar, tabbar, findTop, editorEl, resultsBottom, statusbar);

  const app = new App(editorEl);
  (window as unknown as { __nax: unknown }).__nax = { app, settings, syntaxTree, updateSettings };
  const find = mountFind(app, findTop, resultsBottom);
  const hex = new HexView(editorEl);
  const syncHex = () => {
    const tab = app.active;
    const want = !!tab?.hexView;
    if (want && tab) {
      const editorDom = app.view.dom;
      editorDom.style.display = "none";
      if (tab.path && !tab.dirty) {
        const path = tab.path;
        hex.show({ name: tab.name, size: tab.size, read: (o, l) => backend.readBytes(path, o, l) });
      } else {
        const bytes = new TextEncoder().encode(app.docText(tab));
        hex.show({ name: tab.name + " (" + (tab.dirty ? t("unsaved") + ", UTF-8" : "UTF-8") + ")", size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) });
      }
    } else if (hex.visible) {
      hex.hide();
      app.view.dom.style.display = "";
      app.view.focus();
    }
  };
  app.on("active", syncHex);
  mountTabBar(app, tabbar);
  mountStatusBar(app, statusbar, { gotoLine: () => (hex.visible ? hex.gotoOffset() : cmds.find((c) => c.id === "search.goto")?.run()) });

  const toggleMenuBar = () => {
    updateSettings({ showMenuBar: !settings.showMenuBar });
  };
  const about = () => openAboutDialog();
  const cmds = buildCommands(app, find, {
    toggleMenuBar,
    about,
    hexGoto: () => {
      if (!hex.visible) return false;
      void hex.gotoOffset();
      return true;
    },
  });
  mountMenuBar(menubar, cmds);
  installKeybindings(cmds, () => isModalOpen());

  const applyMenuBar = () => {
    menubar.style.display = settings.showMenuBar ? "" : "none";
  };
  applyMenuBar();
  // Alt alone shows the hidden menu bar temporarily.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !settings.showMenuBar) menubar.style.display = "";
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && !settings.showMenuBar) setTimeout(() => (menubar.style.display = menubar.matches(":hover") ? "" : "none"), 2000);
  });

  // Settings -> editor
  onSettingsChange((s) => {
    applyTheme(s.theme);
    applyMenuBar();
    app.applySettingsToAll((tab) => [
      compartments.wrap.reconfigure(s.wordWrap ? EditorView.lineWrapping : []),
      compartments.lineNumbers.reconfigure(lineNumbersExt(s.lineNumbers, tab.paged?.firstLine ?? 0)),
      compartments.indent.reconfigure(indentExt(s)),
      compartments.activeLine.reconfigure(s.highlightActiveLine ? highlightActiveLine() : []),
      compartments.indentMarkers.reconfigure(s.indentationMarkers ? indentationMarkers({ hideFirstIndent: true }) : []),
      compartments.closeBrackets.reconfigure(s.autoCloseBrackets ? closeBrackets() : []),
      compartments.bracketMatching.reconfigure(s.bracketMatching ? bracketMatching() : []),
    ] as StateEffect<unknown>[]);
    app.emit("status");
  });
  onSystemThemeChange(() => {
    if (settings.theme === "system") applyTheme("system");
  });

  // Editor context menu (replaces the WebView2 default, which has no working Paste)
  editorEl.addEventListener("contextmenu", (e) => {
    if (hex.visible) return;
    e.preventDefault();
    const v = app.view;
    const ro = v.state.readOnly;
    const hasSel = v.state.selection.ranges.some((r) => !r.empty);
    contextMenu(e.clientX, e.clientY, [
      { label: t("Undo"), run: () => undo(v), disabled: ro },
      { label: t("Redo"), run: () => redo(v), disabled: ro },
      "-",
      { label: t("Cut"), run: () => void copySelection(v, true), disabled: ro },
      { label: t("Copy"), run: () => void copySelection(v) },
      { label: t("Paste"), run: () => void pasteClipboard(v), disabled: ro },
      { label: t("Delete"), run: () => deleteSelection(v), disabled: ro || !hasSel },
      "-",
      { label: t("Select All"), run: () => selectAllIn(v) },
    ]);
  });

  // Ctrl+wheel zoom
  editorEl.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      updateSettings({ fontSize: Math.max(6, Math.min(72, settings.fontSize + (e.deltaY < 0 ? 1 : -1))) });
    },
    { passive: false }
  );

  // Drag & drop files from Explorer
  void getCurrentWebview().onDragDropEvent((ev) => {
    if (ev.payload.type === "drop") void app.openFiles(ev.payload.paths);
  });

  // Files handed over by a second instance
  void listen<string[]>("open-files", (ev) => {
    void app.openFiles(ev.payload);
  });

  // Flush unsaved state before the window closes
  const win = getCurrentWindow();
  let closing = false;
  void win.onCloseRequested(async (ev) => {
    if (closing) return;
    ev.preventDefault();
    closing = true;
    try {
      await app.flushAll();
    } finally {
      await win.destroy();
    }
  });

  // Restore session, then open files from the command line
  let restored = false;
  if (settings.restoreSession) {
    try {
      restored = await app.restoreSession();
    } catch (e) {
      console.warn("session restore failed", e);
    }
  }
  const startup = await backend.startupFiles().catch(() => [] as string[]);
  if (startup.length) await app.openFiles(startup);
  else if (!restored) app.newTab();
  if (!app.active && app.tabs.length) app.activate(app.tabs[0]);

  await win.show();
  await win.setFocus();
  app.view.focus();

  // Language change: persist everything, then reload the UI with the new strings
  window.addEventListener("nax:reload", () => {
    void app.flushAll().then(() => location.reload());
  });
  scheduleStartupCheck();

  // Keep the window title in sync
  const updateTitle = () => {
    const t = app.active;
    void win.setTitle(t ? `${t.dirty ? "● " : ""}${t.name}${t.path ? ` (${t.path})` : ""} - Nax-Notepad` : "Nax-Notepad");
  };
  app.on("tabs", updateTitle);
  app.on("active", updateTitle);
  updateTitle();
}

void main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f55;padding:16px">${String(e)}</pre>`;
  void getCurrentWindow().show();
});
