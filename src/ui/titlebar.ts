// Custom window title bar: app name, a command search box in the middle, window buttons.
// The empty areas carry data-tauri-drag-region, so they move the window and maximize it on a
// double click; Tauri keeps the native resize borders of the frameless window.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";
import { h } from "./dialogs";
import { icon } from "./icons";

export interface TitleBarOptions {
  /** Opens the command palette. */
  openPalette: () => void;
  /** Key of the palette command, shown in the search box. */
  paletteKey: () => string | undefined;
}

export function mountTitleBar(root: HTMLElement, opts: TitleBarOptions): { refresh(): void } {
  const win = getCurrentWindow();
  const drag = { "data-tauri-drag-region": "" };
  const logo = h("img", { src: "/icon.png", class: "tb-logo", alt: "", draggable: "false", ...drag });
  const name = h("span", { class: "tb-name", ...drag }, "Nax-Notepad");
  const keyHint = h("span", { class: "tb-key" });
  const search = h(
    "button",
    { class: "tb-search", title: t("Search commands, or find text in the document"), click: () => opts.openPalette() },
    icon("search"),
    h("span", { class: "tb-search-text" }, t("Find text or command")),
    keyHint
  );
  const btn = (cls: string, title: string, run: () => void, ic: HTMLElement) => h("button", { class: `tb-win ${cls}`, title, tabindex: "-1", click: run }, ic);
  const maxIcon = icon("maximize");
  const bMin = btn("min", t("Minimize"), () => void win.minimize(), icon("minimize"));
  const bMax = btn("max", t("Maximize"), () => void win.toggleMaximize(), maxIcon);
  const bClose = btn("close", t("Close"), () => void win.close(), icon("close"));
  root.setAttribute("data-tauri-drag-region", "");
  root.append(
    h("div", { class: "tb-left", ...drag }, logo, name),
    h("div", { class: "tb-center", ...drag }, search),
    h("div", { class: "tb-right", ...drag }, bMin, bMax, bClose)
  );

  const refreshKey = () => {
    const k = opts.paletteKey();
    keyHint.replaceChildren(...(k ? k.split("+").map((p) => h("kbd", {}, p === "Ctrl" && document.documentElement.lang === "de" ? "Strg" : p === "Shift" && document.documentElement.lang === "de" ? "⇧" : p)) : []));
  };
  refreshKey();
  const refreshMax = async () => {
    const max = await win.isMaximized().catch(() => false);
    maxIcon.innerHTML = icon(max ? "restore" : "maximize").innerHTML;
    bMax.title = max ? t("Restore") : t("Maximize");
    document.documentElement.classList.toggle("maximized", max);
  };
  void refreshMax();
  void win.onResized(() => void refreshMax());
  return { refresh: refreshKey };
}
