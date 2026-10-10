import { Command } from "../commands";
import { t } from "../i18n";
import { h } from "./dialogs";

type MenuItem = string | "-" | { title: string; items: MenuItem[] };

const MENUS: { title: string; items: MenuItem[] }[] = [
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
      { title: "Lines", items: ["edit.sortAsc", "edit.sortDesc", "edit.sortNum", "-", "edit.dedupe", "edit.removeEmpty", "edit.reverse", "-", "edit.trim", "edit.tabsToSpaces", "edit.spacesToTabs"] },
      { title: "Case", items: ["edit.upper", "edit.lower", "edit.title"] },
      { title: "Folding", items: ["edit.fold", "edit.unfold", "edit.foldAll", "edit.unfoldAll"] },
      "-",
      "edit.insertDate",
      "edit.matchBracket",
    ],
  },
  { title: "Search", items: ["search.find", "search.replace", "search.findInFiles", "-", "search.next", "search.prev", "-", "search.goto"] },
  {
    title: "View",
    items: ["view.livePreview", "view.hexView", "-", "view.wrap", "view.lineNumbers", "view.menuBar", "-", "view.zoomIn", "view.zoomOut", "view.zoomReset", "-", "view.theme", "-", "view.nextTab", "view.prevTab", "view.switchTab"],
  },
  {
    title: "Markdown",
    items: [
      "md.bold",
      "md.italic",
      "md.strike",
      "md.code",
      "md.highlight",
      "-",
      { title: "Heading", items: ["md.h1", "md.h2", "md.h3", "md.h4", "md.h5", "md.h6", "-", "md.h0"] },
      "-",
      "md.bullet",
      "md.numbered",
      "md.task",
      "md.quote",
      "-",
      "md.link",
      "md.image",
      "md.codeblock",
      "md.table",
      "md.hr",
    ],
  },
  { title: "Settings", items: ["settings.open"] },
  { title: "Help", items: ["help.palette", "-", "help.github", "help.issue", "help.updates", "-", "help.about"] },
];

export function mountMenuBar(root: HTMLElement, cmds: Command[]): void {
  const byId = new Map(cmds.map((c) => [c.id, c]));
  let openDrops: HTMLElement[] = [];
  let openBtn: HTMLElement | null = null;

  const closeAll = () => {
    for (const d of openDrops) d.remove();
    openDrops = [];
    openBtn?.classList.remove("open");
    openBtn = null;
    document.removeEventListener("mousedown", onDown, { capture: true });
    document.removeEventListener("keydown", onKey, { capture: true });
  };
  const closeFrom = (level: number) => {
    for (const d of openDrops.splice(level)) d.remove();
  };
  const onDown = (e: MouseEvent) => {
    if (openDrops.length && !openDrops.some((d) => d.contains(e.target as Node)) && !root.contains(e.target as Node)) closeAll();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeAll();
  };

  const buildDrop = (items: MenuItem[], left: number, top: number, level: number) => {
    closeFrom(level);
    const drop = h("div", { class: "menu-drop" });
    // Keep focus where it was (editor or find box) so Cut/Copy/Paste act on it.
    drop.addEventListener("mousedown", (e) => e.preventDefault());
    for (const it of items) {
      if (it === "-") {
        drop.append(h("div", { class: "ctx-sep" }));
        continue;
      }
      if (typeof it === "object") {
        const row = h("div", { class: "ctx-item submenu" }, h("span", {}, t(it.title)), h("span", { class: "menu-key" }, "▸"));
        row.addEventListener("mouseenter", () => {
          const r = row.getBoundingClientRect();
          buildDrop(it.items, r.right - 2, r.top - 5, level + 1);
        });
        drop.append(row);
        continue;
      }
      const c = byId.get(it);
      if (!c) continue;
      const row = h(
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
      );
      row.addEventListener("mouseenter", () => closeFrom(level + 1));
      drop.append(row);
    }
    document.body.appendChild(drop);
    // Keep the dropdown inside the window: scroll when too tall, flip when too far right.
    const maxH = window.innerHeight - top - 8;
    drop.style.maxHeight = `${Math.max(120, maxH)}px`;
    const w = drop.getBoundingClientRect().width;
    if (left + w > window.innerWidth - 4) left = Math.max(4, (level === 0 ? left : left - w * 2 + 4) - (level === 0 ? left + w - window.innerWidth + 4 : 0));
    drop.style.left = `${left}px`;
    drop.style.top = `${top}px`;
    openDrops.push(drop);
  };

  const show = (btn: HTMLElement, menu: { title: string; items: MenuItem[] }) => {
    if (openBtn === btn) {
      closeAll();
      return;
    }
    closeAll();
    const r = btn.getBoundingClientRect();
    buildDrop(menu.items, r.left, r.bottom, 0);
    openBtn = btn;
    btn.classList.add("open");
    setTimeout(() => {
      document.addEventListener("mousedown", onDown, { capture: true });
      document.addEventListener("keydown", onKey, { capture: true });
    }, 0);
  };

  for (const m of MENUS) {
    const btn = h("button", { class: "menu-btn" }, t(m.title));
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      show(btn, m);
    });
    btn.addEventListener("mouseenter", () => {
      if (openDrops.length && openBtn !== btn) show(btn, m);
    });
    root.append(btn);
  }
}
