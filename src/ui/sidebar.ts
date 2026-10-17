// Side panel: folder workspace (lazy file tree) and function list of the current document.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { App } from "../app";
import { backend, errorText } from "../backend";
import { writeClipboard } from "../clipboard";
import { t } from "../i18n";
import { settings, updateSettings } from "../settings";
import { collectSymbols, DocSymbol } from "../symbols";
import { contextMenu, h, toast } from "./dialogs";

export type SidebarTab = "folders" | "functions";

export interface Sidebar {
  /** Show a panel, or hide the sidebar with null. */
  show(tab: SidebarTab | null): void;
  /** The visible panel, or null. */
  shown(): SidebarTab | null;
}

function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) || s : s;
}

const ICONS: Record<DocSymbol["kind"], string> = { function: "ƒ", class: "◆", type: "▪", heading: "#" };

export function mountSidebar(app: App, root: HTMLElement): Sidebar {
  const tabFolders = h("button", { class: "side-tab", click: () => show("folders") }, t("Folders"));
  const tabFunctions = h("button", { class: "side-tab", click: () => show("functions") }, t("Functions"));
  const btnClose = h("button", { class: "find-close", title: t("Close"), click: () => show(null) }, "×");
  const header = h("div", { class: "side-header" }, tabFolders, tabFunctions, h("span", { class: "side-spacer" }), btnClose);

  // ---- folders ----
  const tree = h("div", { class: "side-tree" });
  const btnAdd = h("button", { class: "btn small", click: () => void addFolder() }, t("Add folder…"));
  const btnRefresh = h("button", { class: "btn small", title: t("Refresh"), click: () => void renderFolders() }, "⟳");
  const foldersPane = h("div", { class: "side-pane" }, h("div", { class: "side-tools" }, btnAdd, btnRefresh), tree);

  // ---- functions ----
  const symFilter = h("input", { class: "input side-filter", type: "text", placeholder: t("Filter") }) as HTMLInputElement;
  const symList = h("div", { class: "side-tree" });
  const functionsPane = h("div", { class: "side-pane" }, h("div", { class: "side-tools" }, symFilter), symList);

  root.append(header, foldersPane, functionsPane);

  const expanded = new Set<string>();

  async function addFolder(): Promise<void> {
    const d = await openDialog({ directory: true, title: t("Add folder to workspace") });
    if (typeof d !== "string") return;
    if (!settings.workspaceFolders.some((f) => f.toLowerCase() === d.toLowerCase())) updateSettings({ workspaceFolders: [...settings.workspaceFolders, d] }, { silent: true });
    expanded.add(d.toLowerCase());
    await renderFolders();
  }

  function removeFolder(path: string): void {
    updateSettings({ workspaceFolders: settings.workspaceFolders.filter((f) => f !== path) }, { silent: true });
    void renderFolders();
  }

  async function renderDir(path: string, container: HTMLElement, depth: number): Promise<void> {
    let entries;
    try {
      entries = await backend.listDir(path);
    } catch (e) {
      container.append(h("div", { class: "side-item error", style: `padding-left:${8 + depth * 14}px` }, errorText(e)));
      return;
    }
    for (const e of entries) {
      const row = h("div", { class: "side-item" + (e.isDir ? " dir" : ""), title: e.path, style: `padding-left:${8 + depth * 14}px` });
      const open = expanded.has(e.path.toLowerCase());
      row.append(h("span", { class: "side-twisty" }, e.isDir ? (open ? "▾" : "▸") : ""), h("span", { class: "side-name" }, e.name));
      container.append(row);
      const children = h("div");
      container.append(children);
      if (e.isDir) {
        if (open) await renderDir(e.path, children, depth + 1);
        row.addEventListener("click", async () => {
          const key = e.path.toLowerCase();
          if (expanded.has(key)) {
            expanded.delete(key);
            children.replaceChildren();
            (row.firstChild as HTMLElement).textContent = "▸";
          } else {
            expanded.add(key);
            (row.firstChild as HTMLElement).textContent = "▾";
            await renderDir(e.path, children, depth + 1);
          }
        });
      } else {
        row.addEventListener("click", () => void app.openFiles([e.path]));
      }
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        contextMenu(ev.clientX, ev.clientY, [
          ...(e.isDir ? [] : [{ label: t("Open"), run: () => void app.openFiles([e.path]) }]),
          { label: t("Reveal in Explorer"), run: () => void backend.revealInExplorer(e.path) },
          {
            label: t("Copy full path"),
            run: () => {
              void writeClipboard(e.path);
              toast(t("Path copied"));
            },
          },
        ]);
      });
    }
  }

  async function renderFolders(): Promise<void> {
    tree.replaceChildren();
    if (!settings.workspaceFolders.length) {
      tree.append(h("div", { class: "side-empty" }, t("Add a folder to browse its files here.")));
      return;
    }
    for (const folder of settings.workspaceFolders) {
      const key = folder.toLowerCase();
      if (!expanded.has(key) && !expanded.has("!" + key)) expanded.add(key);
      const open = expanded.has(key);
      const row = h("div", { class: "side-item root dir", title: folder }, h("span", { class: "side-twisty" }, open ? "▾" : "▸"), h("span", { class: "side-name" }, basename(folder)));
      const children = h("div");
      tree.append(row, children);
      row.addEventListener("click", async () => {
        if (expanded.has(key)) {
          expanded.delete(key);
          expanded.add("!" + key);
          children.replaceChildren();
          (row.firstChild as HTMLElement).textContent = "▸";
        } else {
          expanded.delete("!" + key);
          expanded.add(key);
          (row.firstChild as HTMLElement).textContent = "▾";
          await renderDir(folder, children, 1);
        }
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        contextMenu(ev.clientX, ev.clientY, [
          { label: t("Remove from workspace"), run: () => removeFolder(folder) },
          { label: t("Reveal in Explorer"), run: () => void backend.revealInExplorer(folder) },
          { label: t("Find in Files…"), run: () => window.dispatchEvent(new CustomEvent("nax:findInFolder", { detail: folder })) },
        ]);
      });
      if (open) await renderDir(folder, children, 1);
    }
  }

  // ---- function list ----
  let symTimer: number | undefined;
  let lastSymbols: DocSymbol[] = [];
  function renderSymbols(): void {
    const q = symFilter.value.trim().toLowerCase();
    symList.replaceChildren();
    const tab = app.active;
    const offset = tab?.paged?.firstLine ?? 0;
    const list = q ? lastSymbols.filter((s) => s.name.toLowerCase().includes(q)) : lastSymbols;
    for (const s of list.slice(0, 5000)) {
      const row = h(
        "div",
        { class: `side-item sym ${s.kind}`, title: `${s.name} — ${t("line {n}", { n: s.line + offset })}`, style: `padding-left:${8 + (q ? 0 : s.depth) * 12}px` },
        h("span", { class: "side-icon" }, ICONS[s.kind]),
        h("span", { class: "side-name" }, s.name)
      );
      row.addEventListener("click", () => void app.gotoLine(s.line + offset));
      symList.append(row);
    }
    if (!list.length) symList.append(h("div", { class: "side-empty" }, tab ? t("No functions or headings found.") : ""));
  }
  function refreshSymbols(): void {
    if (current !== "functions") return;
    if (symTimer) clearTimeout(symTimer);
    symTimer = window.setTimeout(() => {
      symTimer = undefined;
      lastSymbols = app.active ? collectSymbols(app.view.state) : [];
      renderSymbols();
    }, 300);
  }
  symFilter.addEventListener("input", renderSymbols);
  symFilter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      symFilter.value = "";
      renderSymbols();
      app.view.focus();
    }
  });
  app.on("doc", refreshSymbols);
  app.on("active", refreshSymbols);

  let current: SidebarTab | null = null;
  function show(tab: SidebarTab | null): void {
    current = tab;
    root.style.display = tab ? "" : "none";
    tabFolders.classList.toggle("on", tab === "folders");
    tabFunctions.classList.toggle("on", tab === "functions");
    foldersPane.style.display = tab === "folders" ? "" : "none";
    functionsPane.style.display = tab === "functions" ? "" : "none";
    if (tab === "folders") void renderFolders();
    if (tab === "functions") {
      lastSymbols = app.active ? collectSymbols(app.view.state) : [];
      renderSymbols();
    }
    updateSettings({ sidebarVisible: !!tab, sidebarTab: tab ?? settings.sidebarTab }, { silent: true });
    for (const p of app.panes) p.view.requestMeasure();
  }

  show(settings.sidebarVisible ? (settings.sidebarTab === "functions" ? "functions" : "folders") : null);
  return { show, shown: () => current };
}
