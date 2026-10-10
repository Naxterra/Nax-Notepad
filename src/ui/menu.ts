import { Command } from "../commands";
import { h } from "./dialogs";

const MENUS: { title: string; items: (string | "-")[] }[] = [
  { title: "File", items: ["file.new", "file.open", "-", "file.save", "file.saveAs", "file.saveAll", "file.reload", "-", "file.copyPath", "-", "file.close", "file.closeOthers", "file.closeAll", "-", "file.exit"] },
  {
    title: "Edit",
    items: [
      "edit.undo",
      "edit.redo",
      "-",
      "edit.cut",
      "edit.copy",
      "edit.paste",
      "edit.selectAll",
      "edit.selectLine",
      "-",
      "edit.duplicateLine",
      "edit.deleteLine",
      "edit.moveLineUp",
      "edit.moveLineDown",
      "edit.toggleComment",
      "edit.indent",
      "edit.outdent",
      "-",
      "edit.upper",
      "edit.lower",
      "edit.title",
      "-",
      "edit.sortAsc",
      "edit.sortDesc",
      "edit.sortNum",
      "edit.dedupe",
      "edit.removeEmpty",
      "edit.reverse",
      "edit.trim",
      "edit.tabsToSpaces",
      "edit.spacesToTabs",
      "-",
      "edit.insertDate",
      "edit.matchBracket",
      "edit.fold",
      "edit.unfold",
      "edit.foldAll",
      "edit.unfoldAll",
    ],
  },
  { title: "Search", items: ["search.find", "search.replace", "search.findInFiles", "-", "search.next", "search.prev", "-", "search.goto"] },
  { title: "View", items: ["view.livePreview", "-", "view.wrap", "view.lineNumbers", "view.menuBar", "-", "view.zoomIn", "view.zoomOut", "view.zoomReset", "-", "view.theme", "-", "view.nextTab", "view.prevTab", "view.switchTab"] },
  { title: "Settings", items: ["settings.open"] },
  { title: "Help", items: ["help.palette", "help.about"] },
];

export function mountMenuBar(root: HTMLElement, cmds: Command[]): void {
  const byId = new Map(cmds.map((c) => [c.id, c]));
  let openMenu: HTMLElement | null = null;
  let openBtn: HTMLElement | null = null;

  const closeAll = () => {
    openMenu?.remove();
    openMenu = null;
    openBtn?.classList.remove("open");
    openBtn = null;
    document.removeEventListener("mousedown", onDown, { capture: true });
    document.removeEventListener("keydown", onKey, { capture: true });
  };
  const onDown = (e: MouseEvent) => {
    if (openMenu && !openMenu.contains(e.target as Node) && !root.contains(e.target as Node)) closeAll();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeAll();
  };

  const show = (btn: HTMLElement, menu: { title: string; items: (string | "-")[] }) => {
    if (openBtn === btn) {
      closeAll();
      return;
    }
    closeAll();
    const drop = h("div", { class: "menu-drop" });
    for (const it of menu.items) {
      if (it === "-") {
        drop.append(h("div", { class: "ctx-sep" }));
        continue;
      }
      const c = byId.get(it);
      if (!c) continue;
      drop.append(
        h(
          "div",
          {
            class: "ctx-item",
            click: () => {
              closeAll();
              void c.run();
            },
          },
          h("span", {}, c.title),
          c.key ? h("span", { class: "menu-key" }, c.key) : null
        )
      );
    }
    const r = btn.getBoundingClientRect();
    drop.style.left = `${r.left}px`;
    drop.style.top = `${r.bottom}px`;
    document.body.appendChild(drop);
    openMenu = drop;
    openBtn = btn;
    btn.classList.add("open");
    setTimeout(() => {
      document.addEventListener("mousedown", onDown, { capture: true });
      document.addEventListener("keydown", onKey, { capture: true });
    }, 0);
  };

  for (const m of MENUS) {
    const btn = h("button", { class: "menu-btn" }, m.title);
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      show(btn, m);
    });
    btn.addEventListener("mouseenter", () => {
      if (openMenu && openBtn !== btn) show(btn, m);
    });
    root.append(btn);
  }
}
