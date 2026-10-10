import { App } from "../app";
import { Eol } from "../backend";
import { allLanguages } from "../editor";
import { settings, updateSettings } from "../settings";
import { h, pickList } from "./dialogs";

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
  const pos = h("span", { class: "sb-item sb-pos", title: "Go to line (Ctrl+G)", click: actions.gotoLine });
  const sel = h("span", { class: "sb-item sb-sel" });
  const size = h("span", { class: "sb-item sb-size" });
  const slider = h("input", { class: "sb-slider", type: "range", min: "0", max: "100", value: "0", title: "Document position (paged file)" }) as HTMLInputElement;
  const paged = h("span", { class: "sb-item sb-paged", title: "Large file: edited in pages, saved as a whole" }, "PAGED");
  const ro = h("span", { class: "sb-item sb-ro" }, "READ-ONLY");
  const lp = h("span", { class: "sb-item sb-lp", title: "Toggle Markdown Live Preview (Ctrl+Shift+V)" });
  const indent = h("span", { class: "sb-item sb-indent", title: "Indentation" });
  const eol = h("span", { class: "sb-item", title: "Line endings" });
  const enc = h("span", { class: "sb-item", title: "Encoding" });
  const lang = h("span", { class: "sb-item", title: "Language" });
  const zoom = h("span", { class: "sb-item", title: "Zoom (Ctrl+Scroll / Ctrl+0 to reset)" });

  const left = h("div", { class: "sb-left" }, pos, sel, size, paged, ro, slider);
  const right = h("div", { class: "sb-right" }, lp, indent, eol, enc, lang, zoom);
  root.append(left, right);

  lp.addEventListener("click", () => app.active && app.toggleLivePreview(app.active));
  zoom.addEventListener("click", () => updateSettings({ fontSize: 14 }));
  indent.addEventListener("click", async () => {
    const it = await pickList("Indentation", [
      ...[2, 4, 8].map((n) => ({ label: `Spaces: ${n}`, value: `s${n}` })),
      ...[2, 4, 8].map((n) => ({ label: `Tabs (width ${n})`, value: `t${n}` })),
    ]);
    if (!it) return;
    updateSettings({ insertSpaces: it.value[0] === "s", tabSize: Number(it.value.slice(1)) });
  });
  eol.addEventListener("click", async () => {
    const it = await pickList("Line endings", [
      { label: "Windows (CRLF)", value: "CRLF" },
      { label: "Unix (LF)", value: "LF" },
      { label: "Classic Mac (CR)", value: "CR" },
    ]);
    if (it && app.active) app.setEol(app.active, it.value as Eol);
  });
  enc.addEventListener("click", async () => {
    if (app.active?.kind === "paged") return;
    const it = await pickList("Encoding (applied on save)", ENCODINGS.map((e) => ({ label: e, value: e })));
    if (it && app.active) app.setEncoding(app.active, it.value);
  });
  lang.addEventListener("click", async () => {
    const it = await pickList("Language", [{ label: "Plain text", value: "" }, ...allLanguages.map((l) => ({ label: l.name, value: l.name, detail: l.desc.extensions.slice(0, 6).map((x) => "." + x).join(" ") }))]);
    if (it && app.active) void app.setLanguage(app.active, it.value || null);
  });
  slider.addEventListener("input", () => {
    const t = app.active;
    if (t?.paged) {
      const line = Math.floor((Number(slider.value) / 1000) * Math.max(0, t.paged.totalLines - 1));
      void t.paged.gotoLine(line);
    }
  });
  slider.max = "1000";

  const render = () => {
    const t = app.active;
    if (!t) return;
    const c = app.cursorInfo();
    pos.textContent = `Ln ${c.line.toLocaleString()}, Col ${c.col}`;
    sel.textContent = c.selLen ? `(${c.selLen.toLocaleString()} selected${c.selLines > 1 ? `, ${c.selLines} lines` : ""})` : "";
    size.textContent = `${c.totalLines.toLocaleString()} lines` + (t.path ? ` · ${fmtSize(t.size)}` : "");
    paged.style.display = t.kind === "paged" ? "" : "none";
    slider.style.display = t.kind === "paged" ? "" : "none";
    if (t.paged && document.activeElement !== slider) {
      slider.value = String(Math.round(((c.line - 1) / Math.max(1, t.paged.totalLines - 1)) * 1000));
    }
    ro.style.display = t.readOnly ? "" : "none";
    const isMd = t.languageName === "Markdown";
    lp.style.display = isMd ? "" : "none";
    lp.textContent = t.livePreview ? "Live Preview" : "Source";
    lp.classList.toggle("on", t.livePreview);
    indent.textContent = settings.insertSpaces ? `Spaces: ${settings.tabSize}` : `Tabs: ${settings.tabSize}`;
    eol.textContent = t.eol;
    enc.textContent = t.encoding;
    lang.textContent = t.languageName ?? "Plain text";
    zoom.textContent = settings.fontSize === 14 ? "" : `${Math.round((settings.fontSize / 14) * 100)}%`;
  };

  app.on("status", render);
  app.on("active", render);
  app.on("tabs", render);
  render();
}
