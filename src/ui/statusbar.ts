import { App } from "../app";
import { allLanguages } from "../editor";
import { settings, updateSettings } from "../settings";
import { h, pickList } from "./dialogs";
import { t } from "../i18n";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export interface StatusActions {
  gotoLine: () => void;
  run: (commandId: string) => void;
  isRecording: () => boolean;
}

export function mountStatusBar(app: App, root: HTMLElement, actions: StatusActions): { render: () => void } {
  const pos = h("span", { class: "sb-item sb-pos", title: t("Go to line (Ctrl+G)"), click: actions.gotoLine });
  const sel = h("span", { class: "sb-item sb-sel" });
  const size = h("span", { class: "sb-item sb-size" });
  const slider = h("input", { class: "sb-slider", type: "range", min: "0", max: "100", value: "0", title: t("Document position (paged file)") }) as HTMLInputElement;
  const paged = h("span", { class: "sb-item sb-paged", title: t("Large file: edited in pages, saved as a whole") }, "PAGED");
  const ro = h("span", { class: "sb-item sb-ro" }, t("READ-ONLY"));
  const hexBadge = h("span", { class: "sb-item sb-paged", title: t("Hex view (Ctrl+Shift+H to leave)") }, "HEX");
  const rec = h("span", { class: "sb-item sb-rec", title: t("Recording a macro (Ctrl+Shift+R stops)") }, "● REC");
  const tail = h("span", { class: "sb-item sb-tail" });
  const lp = h("span", { class: "sb-item sb-lp", title: t("Toggle Markdown Live Preview (Ctrl+Shift+V)") });
  const indent = h("span", { class: "sb-item sb-indent", title: t("Indentation of this file") });
  const eol = h("span", { class: "sb-item", title: t("Line endings") });
  const enc = h("span", { class: "sb-item", title: t("Encoding: reopen or convert") });
  const lang = h("span", { class: "sb-item", title: t("Language") });
  const zoom = h("span", { class: "sb-item", title: t("Zoom (Ctrl+Scroll / Ctrl+0 to reset)") });

  const left = h("div", { class: "sb-left" }, pos, sel, size, paged, ro, hexBadge, rec, tail, slider);
  const right = h("div", { class: "sb-right" }, lp, indent, eol, enc, lang, zoom);
  root.append(left, right);

  lp.addEventListener("click", () => app.active && app.toggleLivePreview(app.active));
  hexBadge.addEventListener("click", () => app.active && app.toggleHexView(app.active));
  rec.addEventListener("click", () => actions.run("macro.record"));
  tail.addEventListener("click", () => actions.run("view.followPause"));
  zoom.addEventListener("click", () => updateSettings({ fontSize: 14 }));
  indent.addEventListener("click", () => actions.run("edit.indentation"));
  eol.addEventListener("click", async () => {
    const it = await pickList(t("Line endings"), [
      { label: t("Windows (CRLF)"), value: "eol.crlf" },
      { label: t("Unix (LF)"), value: "eol.lf" },
      { label: t("Classic Mac (CR)"), value: "eol.cr" },
    ]);
    if (it) actions.run(it.value);
  });
  enc.addEventListener("click", async () => {
    const it = await pickList(t("Encoding"), [
      { label: t("Reopen with Encoding…"), value: "encoding.reopen", detail: t("read the file again with another encoding") },
      { label: t("Convert to Encoding…"), value: "encoding.convert", detail: t("save the text in another encoding") },
    ]);
    if (it) actions.run(it.value);
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
    rec.style.display = actions.isRecording() ? "" : "none";
    if (!tab) return;
    const own = app.owner(tab);
    const c = app.cursorInfo();
    pos.textContent = t("Ln {line}, Col {col}", { line: c.line.toLocaleString(), col: c.col });
    sel.textContent = c.selLen ? t("({n} selected", { n: c.selLen.toLocaleString() }) + (c.selLines > 1 ? t(", {n} lines", { n: c.selLines }) : "") + ")" : "";
    size.textContent = t("{n} lines", { n: c.totalLines.toLocaleString() }) + (own.path ? ` · ${fmtSize(own.size)}` : "");
    paged.style.display = tab.kind === "paged" ? "" : "none";
    slider.style.display = tab.kind === "paged" ? "" : "none";
    if (tab.paged && document.activeElement !== slider) {
      slider.value = String(Math.round(((c.line - 1) / Math.max(1, tab.paged.totalLines - 1)) * 1000));
    }
    ro.style.display = own.readOnly ? "" : "none";
    hexBadge.style.display = tab.hexView ? "" : "none";
    if (own.tail) {
      tail.style.display = "";
      tail.textContent = own.tail.missing ? t("FOLLOW: waiting for file") : own.tail.paused ? t("FOLLOW paused") : t("FOLLOW");
      tail.title = own.tail.paused ? t("Following is paused. Click to resume.") : t("New lines appended to the file are shown automatically. Click to pause.");
      tail.classList.toggle("paused", own.tail.paused);
    } else tail.style.display = "none";
    const isMd = tab.languageName === "Markdown";
    lp.style.display = isMd ? "" : "none";
    lp.textContent = tab.livePreview ? t("Live Preview") : t("Source");
    lp.classList.toggle("on", tab.livePreview);
    const ind = app.indentOf(tab);
    indent.textContent = (ind.spaces ? t("Spaces: {n}", { n: ind.size }) : t("Tabs: {n}", { n: ind.size })) + (own.indent ? "" : "*");
    indent.title = own.indent ? t("Indentation of this file") : t("Indentation of this file (* = default from Settings)");
    eol.textContent = own.eol;
    enc.textContent = own.encoding;
    lang.textContent = tab.languageName ?? t("Plain text");
    zoom.textContent = settings.fontSize === 14 ? "" : `${Math.round((settings.fontSize / 14) * 100)}%`;
  };

  app.on("status", render);
  app.on("active", render);
  app.on("tabs", render);
  render();
  return { render };
}
