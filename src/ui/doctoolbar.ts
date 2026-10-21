// Toolbar above each editor pane: the path of the document as clickable breadcrumbs, and the
// view switches (Text, Hex, Split), "Decode as" (reopen with another encoding), read-only,
// Markdown Live Preview and the inspector.
import { App, Tab, ViewMode } from "../app";
import { backend } from "../backend";
import { writeClipboard } from "../clipboard";
import { ENCODINGS } from "../encodings";
import { t } from "../i18n";
import { settings, updateSettings } from "../settings";
import { contextMenu, h, toast } from "./dialogs";
import { fileIcon, icon } from "./icons";

function splitPath(path: string): { label: string; path: string }[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = path.startsWith("\\\\") ? "\\\\" : "";
  for (const [i, p] of parts.entries()) {
    acc = i === 0 ? acc + p : acc + "\\" + p;
    out.push({ label: p, path: i === 0 && /^[a-zA-Z]:$/.test(p) ? p + "\\" : acc });
  }
  return out;
}

export function mountDocToolbar(app: App, root: HTMLElement, pane: 0 | 1): { render(): void } {
  const crumbs = h("div", { class: "crumbs" });
  const controls = h("div", { class: "doc-controls" });
  root.append(crumbs, controls);
  let lastKey = "";

  const folderMenu = async (e: MouseEvent, dir: string) => {
    let entries;
    try {
      entries = await backend.listDir(dir);
    } catch (err) {
      toast(String(err));
      return;
    }
    const items = entries.slice(0, 300).map((x) => ({
      label: (x.isDir ? "▸ " : "   ") + x.name,
      run: () => (x.isDir ? void folderMenu(e, x.path) : void app.openFiles([x.path])),
    }));
    contextMenu(e.clientX, e.clientY + 6, items.length ? items : [{ label: t("(empty)"), run: () => undefined, disabled: true }]);
  };

  const renderCrumbs = (tab: Tab) => {
    const own = app.owner(tab);
    crumbs.replaceChildren(icon(fileIcon(own.name), "crumb-icon"));
    if (!own.path) {
      crumbs.append(h("span", { class: "crumb current" }, own.name), h("span", { class: "crumb-note" }, t("not saved yet")));
      return;
    }
    const all = splitPath(own.path);
    // Long paths: drive, an ellipsis for the middle folders, then the last two folders and the file.
    const hidden = all.length > 5 ? all.slice(1, all.length - 3) : [];
    const segs = hidden.length ? [all[0], { label: "…", path: "" }, ...all.slice(all.length - 3)] : all;
    segs.forEach((seg, i) => {
      const last = i === segs.length - 1;
      if (!seg.path) {
        const more = h("button", { class: "crumb", title: hidden.map((x) => x.label).join(" / ") }, "…");
        more.addEventListener("click", (e) => contextMenu(e.clientX, e.clientY + 6, hidden.map((x) => ({ label: x.label, run: () => void folderMenu(e, x.path) }))));
        crumbs.append(more, h("span", { class: "crumb-sep" }, "/"));
        return;
      }
      const el = h("button", { class: "crumb" + (last ? " current" : ""), title: seg.path }, seg.label);
      el.addEventListener("click", (e) => {
        if (!last) void folderMenu(e, seg.path);
        else
          contextMenu(e.clientX, e.clientY + 6, [
            { label: t("Copy full path"), run: () => void writeClipboard(own.path!).then(() => toast(t("Path copied"))) },
            { label: t("Reveal in Explorer"), run: () => void backend.revealInExplorer(own.path!) },
          ]);
      });
      crumbs.append(el);
      if (!last) crumbs.append(h("span", { class: "crumb-sep" }, "/"));
    });
  };

  const render = () => {
    const tab = app.panes[pane]?.tab ?? null;
    root.style.display = tab ? "" : "none";
    if (!tab) return;
    const own = app.owner(tab);
    const mode = app.viewMode(tab);
    const key = [tab.id, own.path, own.name, mode, own.readOnly, own.encoding, tab.languageName, tab.livePreview, settings.inspectorVisible, own.lockedReadOnly ?? ""].join("|");
    if (key === lastKey) return;
    lastKey = key;
    renderCrumbs(tab);

    const seg = h("div", { class: "seg", role: "tablist" });
    const modes: [ViewMode, string, string][] = [
      ["text", t("Text"), t("Text view")],
      ["hex", t("Hex"), t("Hex editor (Ctrl+Shift+H)")],
      ["split", t("Split"), t("Text and bytes side by side")],
    ];
    for (const [m, label, title] of modes) {
      seg.append(h("button", { class: "seg-btn" + (m === mode ? " on" : ""), title, click: () => void app.setViewMode(tab, m) }, label));
    }

    const parts: HTMLElement[] = [];
    if (tab.languageName === "Markdown" && mode !== "hex") {
      parts.push(h("button", { class: "tool-btn" + (tab.livePreview ? " on" : ""), title: t("Toggle Markdown Live Preview (Ctrl+Shift+V)"), click: () => app.toggleLivePreview(tab) }, icon("eye"), h("span", {}, t("Live Preview"))));
    }
    parts.push(seg);
    if (own.path) {
      const sel = h("select", { class: "tool-select", title: t("Read the file again with another encoding") }) as HTMLSelectElement;
      const list = ENCODINGS.includes(own.encoding) ? ENCODINGS : [own.encoding, ...ENCODINGS];
      for (const e of list) sel.append(h("option", { value: e }, e));
      sel.value = own.encoding;
      sel.addEventListener("change", () => {
        const enc = sel.value;
        sel.value = own.encoding;
        void app.reopenWithEncoding(tab, enc);
      });
      parts.push(h("label", { class: "tool-label" }, h("span", {}, t("Decode as:")), sel));
    }
    const ro = own.readOnly;
    parts.push(
      h(
        "button",
        {
          class: "tool-btn" + (ro ? " on" : ""),
          title: ro ? t("Allow editing") : t("Protect against changes"),
          click: () => app.setReadOnly(tab, !ro),
        },
        icon(ro ? "lock" : "unlock"),
        h("span", {}, ro ? t("Read only") : t("Editable"))
      )
    );
    if (mode !== "text" && !settings.inspectorVisible) {
      parts.push(h("button", { class: "icon-btn", title: t("Show the inspector"), click: () => updateSettings({ inspectorVisible: true }) }, icon("panelRight")));
    }
    controls.replaceChildren(...parts);
  };

  app.on("active", render);
  app.on("tabs", render);
  app.on("status", render);
  app.on("layout", render);
  render();
  return {
    render: () => {
      lastKey = "";
      render();
    },
  };
}
