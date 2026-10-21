// Inspector panel beside the hex view: the selection (offsets, length, the bytes as text and
// the value at the cursor as numbers) and the file (size, type, access, encoding).
import { App, Tab } from "../app";
import { parseHex, textBytes } from "../hexbuffer";
import { t } from "../i18n";
import { detectSignature } from "../signature";
import { settings, updateSettings } from "../settings";
import { h, prompt, toast } from "./dialogs";
import { HexView } from "./hexview";
import { icon, IconName } from "./icons";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const hex8 = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(8, "0");

/** Numbers read from the bytes at the cursor. */
export function interpret(bytes: Uint8Array, littleEndian: boolean): { label: string; value: string }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { label: string; value: string }[] = [];
  const add = (label: string, need: number, read: () => string) => out.push({ label, value: bytes.length >= need ? read() : "–" });
  add("Int8", 1, () => String(dv.getInt8(0)));
  add("UInt8", 1, () => String(dv.getUint8(0)));
  add("Int16", 2, () => String(dv.getInt16(0, littleEndian)));
  add("UInt16", 2, () => String(dv.getUint16(0, littleEndian)));
  add("Int32", 4, () => String(dv.getInt32(0, littleEndian)));
  add("UInt32", 4, () => String(dv.getUint32(0, littleEndian)));
  add("Int64", 8, () => dv.getBigInt64(0, littleEndian).toString());
  add("UInt64", 8, () => dv.getBigUint64(0, littleEndian).toString());
  add("Float32", 4, () => String(dv.getFloat32(0, littleEndian)));
  add("Float64", 8, () => String(dv.getFloat64(0, littleEndian)));
  add("Binary", 1, () => dv.getUint8(0).toString(2).padStart(8, "0"));
  return out;
}

export interface Inspector {
  refresh(): void;
}

export function mountInspector(root: HTMLElement, app: App, pane: number, hex: HexView): Inspector {
  let tab: "selection" | "file" = "selection";
  let little = true;
  const tSel = h("button", { class: "seg-btn", click: () => ((tab = "selection"), refresh()) }, t("Selection"));
  const tFile = h("button", { class: "seg-btn", click: () => ((tab = "file"), refresh()) }, t("File"));
  const collapse = h("button", { class: "icon-btn", title: t("Hide the inspector"), click: () => updateSettings({ inspectorVisible: false }) }, icon("chevronRight"));
  const body = h("div", { class: "insp-body" });
  root.append(h("div", { class: "insp-head" }, h("span", { class: "insp-title" }, t("Inspector")), collapse), h("div", { class: "seg insp-tabs" }, tSel, tFile), body);

  const row = (label: string, value: string | HTMLElement, mono = true) => h("div", { class: "insp-row" }, h("span", { class: "insp-label" }, label), typeof value === "string" ? h("span", { class: "insp-value" + (mono ? " mono" : "") }, value) : value);
  const section = (title: string) => h("div", { class: "insp-section" }, title);
  const action = (ic: IconName, label: string, run: () => void) => h("button", { class: "insp-action", click: run }, icon(ic), h("span", {}, label));

  const actions = () =>
    h(
      "div",
      { class: "insp-actions" },
      section(t("Quick actions")),
      action("copy", t("Copy as hex"), () => void hex.copy(false, "hex")),
      action("copy", t("Copy as text"), () => void hex.copy(false, "text")),
      action("arrowRight", t("Go to offset…"), () => void hex.gotoOffset()),
      action("search", t("Find byte pattern…"), () => void findPattern())
    );

  async function findPattern(): Promise<void> {
    const q = await prompt(t("Find byte pattern"), t("Hex bytes (for example 25 50 44 46) or text:"), "");
    if (!q) return;
    const bytes = parseHex(q) ?? textBytes(q);
    if (!(await hex.findBytes(bytes, false))) toast(t("Not found"));
    hex.focus();
  }

  let seq = 0;
  async function refresh(): Promise<void> {
    const my = ++seq;
    const visible = root.style.display !== "none";
    const ptab: Tab | null = app.panes[pane]?.tab ?? null;
    const buf = hex.buffer;
    if (!visible || !ptab || !buf) return;
    tSel.classList.toggle("on", tab === "selection");
    tFile.classList.toggle("on", tab === "file");
    const own = app.owner(ptab);
    const nodes: HTMLElement[] = [];
    if (tab === "selection") {
      const st = hex.state;
      const len = st.to - st.from;
      await buf.ready(st.cursor, st.cursor + 8);
      if (len > 0) await buf.ready(st.from, Math.min(st.to, st.from + 256));
      if (my !== seq) return;
      nodes.push(h("div", { class: "insp-big" }, len > 0 ? t("{n} bytes selected", { n: len.toLocaleString() }) : t("Cursor at {offset}", { offset: hex8(st.cursor) })));
      if (len > 0) {
        nodes.push(row(t("Start"), hex8(st.from)), row(t("End"), hex8(st.to - 1)), row(t("Length"), t("{n} bytes", { n: len.toLocaleString() }), false));
        const preview = buf.slice(st.from, Math.min(st.to, st.from + 256));
        const text = Array.from(preview, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("") + (len > 256 ? "…" : "");
        nodes.push(section(t("Selected bytes as text")), h("div", { class: "insp-preview" }, text));
      } else {
        nodes.push(row(t("Offset"), `${hex8(st.cursor)} (${st.cursor.toLocaleString()})`));
      }
      const at = buf.slice(st.cursor, st.cursor + 8);
      const endian = h("div", { class: "seg small" });
      for (const [le, label] of [
        [true, "LE"],
        [false, "BE"],
      ] as const) {
        const b = h("button", { class: "seg-btn" + (little === le ? " on" : ""), title: le ? t("Little-endian") : t("Big-endian"), click: () => ((little = le), refresh()) }, label);
        endian.append(b);
      }
      nodes.push(h("div", { class: "insp-section with-control" }, h("span", {}, t("Value at cursor")), endian));
      for (const v of interpret(at, little)) nodes.push(row(v.label, v.value));
    } else {
      await buf.ready(0, 16);
      if (my !== seq) return;
      const sig = detectSignature(buf.slice(0, 16));
      const access = h("span", { class: "insp-value" }, icon(own.readOnly ? "lock" : "unlock"), " ", own.readOnly ? t("Read only") : t("Editable"));
      nodes.push(
        h("div", { class: "insp-big" }, own.name),
        row(t("Size"), `${fmtSize(buf.size)} (${buf.size.toLocaleString()} ${t("bytes")})`, false),
        row(t("Type"), sig ? t(sig) : t("Unknown"), false),
        row(t("Access"), access),
        row(t("Encoding"), own.encoding, false),
        row(t("Line endings"), own.eol, false)
      );
      if (own.mtime) nodes.push(row(t("Modified"), new Date(own.mtime).toLocaleString(), false));
      if (own.path) nodes.push(section(t("Path")), h("div", { class: "insp-path", title: own.path }, own.path));
      if (sig) nodes.push(h("div", { class: "insp-note" }, t("Type identified from the first bytes.")));
    }
    nodes.push(actions());
    body.replaceChildren(...nodes);
  }

  let raf = 0;
  const later = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      void refresh();
    });
  };
  hex.onState(later);
  app.on("tabs", later);
  return {
    refresh: () => {
      root.style.display = settings.inspectorVisible && hex.visible ? "" : "none";
      void refresh();
    },
  };
}
