import { closeBrackets } from "@codemirror/autocomplete";
import { bracketMatching, syntaxTree } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { EditorView, highlightActiveLine } from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App, Tab } from "./app";
import { backend, errorText } from "./backend";
import { addMacroCommands, buildCommands, Command, installKeybindings, recorder, runCommand } from "./commands";
import { compartments, lineNumbersExt } from "./editor";
import { applyKeymap } from "./keymap";
import { loadSettings, onSettingsChange, settings, updateSettings } from "./settings";
import { applyTheme, onSystemThemeChange } from "./theme";
import { confirm3, contextMenu, h, isModalOpen, message, toast } from "./ui/dialogs";
import { copySelection, deleteSelection, pasteClipboard, selectAllIn } from "./clipboard";
import { redo, undo } from "@codemirror/commands";
import { t } from "./i18n";
import { initLanguage } from "./i18n";
import { openAboutDialog } from "./ui/about";
import { scheduleStartupCheck } from "./update";
import { HexView } from "./ui/hexview";
import { mountFind } from "./ui/find";
import { DynamicItem, mountMenuBar } from "./ui/menu";
import { openNppImport } from "./ui/nppdialog";
import { exportSettings, importSettings } from "./ui/settingsdialog";
import { openShortcutDialog } from "./ui/shortcuts";
import { mountSidebar } from "./ui/sidebar";
import { mountStatusBar } from "./ui/statusbar";
import { mountTabBar } from "./ui/tabbar";
import "./styles.css";

function shortPath(p: string, max = 90): string {
  return p.length <= max ? p : p.slice(0, 20) + "…" + p.slice(p.length - (max - 21));
}

async function main(): Promise<void> {
  await loadSettings();
  initLanguage(settings.language);
  applyTheme(settings.theme);

  // Layout: menu bar, find bar, [sidebar | pane 1 | pane 2], results, status bar.
  const root = document.getElementById("app")!;
  const menubar = h("div", { class: "menubar" });
  const findTop = h("div", { class: "find-top" });
  const sidebarEl = h("div", { class: "sidebar" });
  const editorHosts = [h("div", { class: "editor" }), h("div", { class: "editor" })];
  const tabbars = [h("div", { class: "tabbar" }), h("div", { class: "tabbar" })];
  const paneEls = [h("div", { class: "pane" }, tabbars[0], editorHosts[0]), h("div", { class: "pane" }, tabbars[1], editorHosts[1])];
  paneEls[1].style.display = "none";
  const panesEl = h("div", { class: "panes" }, paneEls[0], paneEls[1]);
  const work = h("div", { class: "work" }, sidebarEl, panesEl);
  const resultsBottom = h("div", { class: "results-bottom" });
  const statusbar = h("div", { class: "statusbar" });
  root.append(menubar, findTop, work, resultsBottom, statusbar);

  const app = new App(editorHosts);
  const find = mountFind(app, findTop, resultsBottom);

  // Hex view per pane, shown instead of the editor for tabs in hex mode.
  const hexes = editorHosts.map((host) => new HexView(host));
  // Shows the hex editor instead of the text editor for tabs in hex mode, and follows reloads
  // (a file changed by another program gets a fresh buffer).
  const hexTab: (Tab | null)[] = [null, null];
  let hexSync = Promise.resolve();
  const syncHex = () => {
    hexSync = hexSync.then(async () => {
      for (const [i, pane] of app.panes.entries()) {
        const tab = pane.tab;
        const hex = hexes[i];
        if (tab?.hexView) {
          pane.view.dom.style.display = "none";
          try {
            const info = await app.hexFor(tab);
            if (pane.tab !== tab) continue;
            const isNew = hex.buffer !== info.buffer || hexTab[i] !== tab || !hex.visible;
            hexTab[i] = tab;
            hex.show({ ...info, onChange: () => app.noteHexChange(tab) }, isNew && i === app.focused);
          } catch (e) {
            toast(errorText(e), 6000);
          }
        } else if (hex.visible) {
          hexTab[i] = null;
          hex.hide();
          pane.view.dom.style.display = "";
          if (i === app.focused) pane.view.focus();
        }
      }
    });
  };
  app.on("active", syncHex);
  app.on("layout", syncHex);
  app.on("tabs", syncHex);
  mountTabBar(app, tabbars[0], 0);
  mountTabBar(app, tabbars[1], 1);
  const sidebar = mountSidebar(app, sidebarEl);

  let keys: { rebuild(): void } | null = null;
  const refreshKeys = () => {
    applyKeymap(cmds, settings.keymapPreset, settings.keyOverrides);
    keys?.rebuild();
  };
  const macrosChanged = () => {
    addMacroCommands(cmds);
    refreshKeys();
  };
  const toggleMenuBar = () => {
    updateSettings({ showMenuBar: !settings.showMenuBar });
  };
  const extras = {
    toggleMenuBar,
    about: () => openAboutDialog(),
    hex: () => (hexes[app.focused].visible ? hexes[app.focused] : null),
    hexGoto: () => {
      const hex = hexes[app.focused];
      if (!hex.visible) return false;
      void hex.gotoOffset();
      return true;
    },
    showSidebar: (tab: "folders" | "functions" | null) => sidebar.show(tab),
    sidebarShown: () => sidebar.shown(),
    openShortcuts: () => openShortcutDialog(cmds, refreshKeys),
    nppImport: () => void openNppImport(app, cmds, refreshKeys, macrosChanged),
    exportSettings: () => void exportSettings(),
    importSettings: () => void importSettings(macrosChanged),
    macrosChanged,
    keymapChanged: refreshKeys,
  };
  const cmds: Command[] = buildCommands(app, find, extras);
  const run = (id: string) => {
    const c = cmds.find((x) => x.id === id);
    if (c) void runCommand(c);
  };
  const status = mountStatusBar(app, statusbar, {
    gotoLine: () => (hexes[app.focused].visible ? void hexes[app.focused].gotoOffset() : run("search.goto")),
    run,
    isRecording: () => recorder.recording,
  });
  recorder.onChange(() => status.render());
  (window as unknown as { __nax: unknown }).__nax = { app, settings, syntaxTree, updateSettings, cmds, recorder, run };

  const dynamicMenus: Record<string, () => DynamicItem[]> = {
    recent: () => {
      const items: DynamicItem[] = settings.recentFiles.map((p) => ({ label: shortPath(p), detail: p, run: () => void app.openFiles([p]) }));
      if (items.length) items.push("-", { label: t("Clear Recent Files"), run: () => app.clearRecent() });
      return items;
    },
    macros: () =>
      settings.macros.map((m) => ({
        label: m.name,
        run: () => run(`macro.user.${m.name}`),
      })),
  };
  mountMenuBar(menubar, () => cmds, dynamicMenus);
  keys = installKeybindings(() => cmds, {
    isBlocked: () => isModalOpen(),
    isEditorTarget: (target) => !!(target as HTMLElement | null)?.closest?.(".cm-content"),
  });

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
      compartments.indent.reconfigure(app.indentExtFor(tab)),
      compartments.activeLine.reconfigure(s.highlightActiveLine ? highlightActiveLine() : []),
      compartments.indentMarkers.reconfigure(s.indentationMarkers ? indentationMarkers({ hideFirstIndent: true }) : []),
      compartments.closeBrackets.reconfigure(s.autoCloseBrackets ? closeBrackets() : []),
      compartments.bracketMatching.reconfigure(s.bracketMatching ? bracketMatching() : []),
      compartments.whitespace.reconfigure(app.whitespaceExtFor(tab)),
    ] as StateEffect<unknown>[]);
    app.emit("status");
  });
  onSystemThemeChange(() => {
    if (settings.theme === "system") applyTheme("system");
  });

  window.addEventListener("nax:findInFolder", (e) => find.searchIn((e as CustomEvent<string>).detail));

  // The WebView2 browser menu (Print, More tools, ...) does not belong in the app; text inputs
  // keep their native menu.
  document.addEventListener("contextmenu", (e) => {
    const el = e.target as HTMLElement;
    if (!e.defaultPrevented && !el.closest("input, textarea")) e.preventDefault();
  });

  // Editor context menu (replaces the WebView2 default, which has no working Paste)
  panesEl.addEventListener("contextmenu", (e) => {
    const host = (e.target as HTMLElement).closest(".editor");
    if (!host || hexes.some((x) => x.visible && x.root.contains(e.target as Node))) return;
    e.preventDefault();
    const i = editorHosts.indexOf(host as HTMLDivElement);
    if (i >= 0 && i !== app.focused && app.panes[i].tab) app.focusPane(i);
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
      "-",
      { label: t("Toggle Bookmark"), run: () => run("bookmark.toggle") },
    ]);
  });

  // Ctrl+wheel zoom
  panesEl.addEventListener(
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
  // Close only after unsaved work is stored for recovery; on failure the user decides.
  void win.onCloseRequested(async (ev) => {
    if (closing) return;
    ev.preventDefault();
    closing = true;
    try {
      for (;;) {
        try {
          await app.flushAll();
          break;
        } catch (e) {
          const r = await confirm3(
            t("Unsaved text could not be stored"),
            t("Nax-Notepad could not store your unsaved text for recovery:\n{error}\n\nRetry, close and discard it, or cancel to keep the window open and save your work with Save As.", { error: errorText(e) }),
            [t("Retry"), t("Close and discard")]
          );
          if (r === "yes") continue;
          if (r === "no") break;
          return; // keep the window open
        }
      }
      await win.destroy();
    } finally {
      closing = false;
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
    app
      .flushAll()
      .then(() => location.reload())
      .catch((e) => void message(t("Unsaved text could not be stored"), errorText(e)));
  });
  scheduleStartupCheck();

  // Keep the window title in sync
  const updateTitle = () => {
    const tab = app.active ? app.owner(app.active) : null;
    void win.setTitle(tab ? `${tab.dirty ? "● " : ""}${tab.name}${tab.path ? ` (${tab.path})` : ""} - Nax-Notepad` : "Nax-Notepad");
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
