import { App } from "../app";
import { Eol } from "../backend";
import { allLanguages } from "../editor";
import { settings, updateSettings } from "../settings";
import { h, pickList } from "./dialogs";
import { t } from "../i18n";

const ENCODINGS = [
  "UTF-8",
  "UTF-8-BOM",
  "UTF-16LE",
  "UTF-16BE",
  "windows-1252",
  "windows-1250",
  "windows-1251",
  "ISO-8859-1",
  "ISO-8859-2",
  "ISO-8859-15",
  "Shift_JIS",
  "GBK",
  "EUC-KR",
  "KOI8-R",
  "macintosh",
];

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function mountStatusBar(app: App, root: HTMLElement, actions: { gotoLine: () => void }): void {
  const pos = h("span", { class: "sb-item sb-pos", title: t("Go to line (Ctrl+G)"), click: actions.gotoLine });
  const sel = h("span", { class: "sb-item sb-sel" });
  const size = h("span", { class: "sb-item sb-size" });
  const slider = h("input", { class: "sb-slider", type: "range", min: "0", max: "100", value: "0", title: t("Document position (paged file)") }) as HTMLInputElement;
  const paged = h("span", { class: "sb-item sb-paged", title: t("Large file: edited in pages, saved as a whole") }, "PAGED");
  const ro = h("span", { class: "sb-item sb-ro" }, t("READ-ONLY"));
  const hexBadge = h("span", { class: "sb-item sb-paged", title: t("Hex view (Ctrl+Shift+H to leave)") }, "HEX");
  const lp = h("span", { class: "sb-item sb-lp", title: t("Toggle Markdown Live Preview (Ctrl+Shift+V)") });
  const indent = h("span", { class: "sb-item sb-indent", title: t("Indentation") });
  const eol = h("span", { class: "sb-item", title: t("Line endings") });
  const enc = h("span", { class: "sb-item", title: t("Encoding") });
  const lang = h("span", { class: "sb-item", title: t("Language") });
  const zoom = h("span", { class: "sb-item", title: t("Zoom (Ctrl+Scroll / Ctrl+0 to reset)") });

  const left = h("div", { class: "sb-left" }, pos, sel, size, paged, ro, hexBadge, slider);
  const right = h("div", { class: "sb-right" }, lp, indent, eol, enc, lang, zoom);
  root.append(left, right);

  lp.addEventListener("click", () => app.active && app.toggleLivePreview(app.active));
  hexBadge.addEventListener("click", () => app.active && app.toggleHexView(app.active));
  zoom.addEventListener("click", () => updateSettings({ fontSize: 14 }));
  indent.addEventListener("click", async () => {
    const it = await pickList(t("Indentation"), [
      ...[2, 4, 8].map((n) => ({ label: t("Spaces: {n}", { n }), value: `s${n}` })),
      ...[2, 4, 8].map((n) => ({ label: t("Tabs (width {n})", { n }), value: `t${n}` })),
    ]);
    if (!it) return;
    updateSettings({ insertSpaces: it.value[0] === "s", tabSize: Number(it.value.slice(1)) });
  });
  eol.addEventListener("click", async () => {
    const it = await pickList(t("Line endings"), [
      { label: t("Windows (CRLF)"), value: "CRLF" },
      { label: t("Unix (LF)"), value: "LF" },
      { label: t("Classic Mac (CR)"), value: "CR" },
    ]);
    if (it && app.active) app.setEol(app.active, it.value as Eol);
  });
  enc.addEventListener("click", async () => {
    if (app.active?.kind === "paged") return;
    const it = await pickList(t("Encoding (applied on save)"), ENCODINGS.map((e) => ({ label: e, value: e })));
    if (it && app.active) app.setEncoding(app.active, it.value);
  });
  lang.addEventListener("click", async () => {
    const it = await pickList(t("Language"), [{ label: t("Plain text"), value: "" }, ...allLanguages.map((l) => ({ label: l.name, value: l.name, detail: l.desc.extensions.slice(0, 6).map((x) => "." + x).join(" ") }))]);
    if (it && app.active) void app.setLanguage(app.active, it.value || null);
  });
  slider.addEventListener("input", () => {
    const tab = app.active;
    if (tab?.paged) {
      const line = Math.floor((Number(slider.value) / 1000) * Math.max(0, tab.paged.totalLines - 1));
      void tab.paged.gotoLine(line);
    }
  });
  slider.max = "1000";

  const render = () => {
    const tab = app.active;
    if (!tab) return;
    const c = app.cursorInfo();
    pos.textContent = t("Ln {line}, Col {col}", { line: c.line.toLocaleString(), col: c.col });
    sel.textContent = c.selLen ? t("({n} selected", { n: c.selLen.toLocaleString() }) + (c.selLines > 1 ? t(", {n} lines", { n: c.selLines }) : "") + ")" : "";
    size.textContent = t("{n} lines", { n: c.totalLines.toLocaleString() }) + (tab.path ? ` · ${fmtSize(tab.size)}` : "");
    paged.style.display = tab.kind === "paged" ? "" : "none";
    slider.style.display = tab.kind === "paged" ? "" : "none";
    if (tab.paged && document.activeElement !== slider) {
      slider.value = String(Math.round(((c.line - 1) / Math.max(1, tab.paged.totalLines - 1)) * 1000));
    }
    ro.style.display = tab.readOnly ? "" : "none";
    hexBadge.style.display = tab.hexView ? "" : "none";
    const isMd = tab.languageName === "Markdown";
    lp.style.display = isMd ? "" : "none";
    lp.textContent = tab.livePreview ? t("Live Preview") : t("Source");
    lp.classList.toggle("on", tab.livePreview);
    indent.textContent = settings.insertSpaces ? t("Spaces: {n}", { n: settings.tabSize }) : t("Tabs: {n}", { n: settings.tabSize });
    eol.textContent = tab.eol;
    enc.textContent = tab.encoding;
    lang.textContent = tab.languageName ?? t("Plain text");
    zoom.textContent = settings.fontSize === 14 ? "" : `${Math.round((settings.fontSize / 14) * 100)}%`;
  };

  app.on("status", render);
  app.on("active", render);
  app.on("tabs", render);
  render();
}
