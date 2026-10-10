// Small in-app modal dialogs: confirm, prompt, list picker. All keyboard friendly.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k, v as EventListener);
    else if (typeof v === "boolean") {
      if (v) el.setAttribute(k, "");
    } else if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

let openModal: HTMLElement | null = null;

export function showModal(content: HTMLElement, onClose: () => void = () => undefined): () => void {
  closeModal();
  const overlay = h("div", { class: "modal-overlay" }, content);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  const close = () => {
    if (overlay.parentElement) overlay.remove();
    if (openModal === overlay) openModal = null;
    onClose();
  };
  document.body.appendChild(overlay);
  openModal = overlay;
  return close;
}

export function closeModal(): void {
  if (openModal) {
    openModal.remove();
    openModal = null;
  }
}

export function isModalOpen(): boolean {
  return openModal !== null;
}

export function confirm3(title: string, text: string, labels: [string, string] = ["Save", "Don't save"]): Promise<"yes" | "no" | "cancel"> {
  return new Promise((resolve) => {
    let result: "yes" | "no" | "cancel" = "cancel";
    const btnYes = h("button", { class: "btn primary", click: () => done("yes") }, labels[0]);
    const btnNo = h("button", { class: "btn", click: () => done("no") }, labels[1]);
    const btnCancel = h("button", { class: "btn", click: () => done("cancel") }, "Cancel");
    const box = h(
      "div",
      { class: "modal" },
      h("div", { class: "modal-title" }, title),
      h("div", { class: "modal-text" }, text),
      h("div", { class: "modal-buttons" }, btnYes, btnNo, btnCancel)
    );
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Enter") e.preventDefault();
      if (e.key === "Escape") done("cancel");
      if (e.key === "Enter" && (document.activeElement === box || document.activeElement === btnYes)) done("yes");
    });
    box.tabIndex = -1;
    const close = showModal(box, () => resolve(result));
    const done = (r: "yes" | "no" | "cancel") => {
      result = r;
      close();
    };
    btnYes.focus();
  });
}

export function prompt(title: string, label: string, initial = "", placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h("input", { class: "input", type: "text", value: initial, placeholder }) as HTMLInputElement;
    const box = h(
      "div",
      { class: "modal" },
      h("div", { class: "modal-title" }, title),
      h("label", { class: "modal-text" }, label, input),
      h(
        "div",
        { class: "modal-buttons" },
        h("button", { class: "btn primary", click: () => done(input.value) }, "OK"),
        h("button", { class: "btn", click: () => done(null) }, "Cancel")
      )
    );
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Enter") e.preventDefault();
      if (e.key === "Escape") done(null);
      if (e.key === "Enter") done(input.value);
    });
    const close = showModal(box, () => resolve(result));
    const done = (r: string | null) => {
      result = r;
      close();
    };
    input.focus();
    input.select();
  });
}

export interface PickItem {
  label: string;
  detail?: string;
  value: string;
  hint?: string;
}

/** Fuzzy, keyboard-driven list picker (used by the command palette and the status bar menus). */
export function pickList(title: string, items: PickItem[], opts: { placeholder?: string; initial?: string } = {}): Promise<PickItem | null> {
  return new Promise((resolve) => {
    let result: PickItem | null = null;
    let filtered = items;
    let index = 0;
    const input = h("input", { class: "input", type: "text", placeholder: opts.placeholder ?? "Type to filter…" }) as HTMLInputElement;
    const list = h("div", { class: "pick-list" });
    const render = () => {
      list.replaceChildren();
      filtered.slice(0, 200).forEach((it, i) => {
        const row = h(
          "div",
          { class: "pick-row" + (i === index ? " selected" : ""), mousedown: (e) => e.preventDefault(), click: () => done(it) },
          h("span", { class: "pick-label" }, it.label),
          it.detail ? h("span", { class: "pick-detail" }, it.detail) : null,
          it.hint ? h("span", { class: "pick-hint" }, it.hint) : null
        );
        list.append(row);
      });
      const sel = list.children[index] as HTMLElement | undefined;
      sel?.scrollIntoView({ block: "nearest" });
    };
    const filter = () => {
      const q = input.value.trim().toLowerCase();
      filtered = q ? items.filter((it) => fuzzy(q, (it.label + " " + (it.detail ?? "")).toLowerCase())) : items;
      filtered = q ? filtered.sort((a, b) => score(q, a.label.toLowerCase()) - score(q, b.label.toLowerCase())) : filtered;
      index = 0;
      render();
    };
    input.addEventListener("input", filter);
    const box = h("div", { class: "modal picker" }, title ? h("div", { class: "modal-title" }, title) : null, input, list);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        index = Math.min(index + 1, filtered.length - 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        index = Math.max(index - 1, 0);
        render();
      } else if (e.key === "PageDown") {
        e.preventDefault();
        index = Math.min(index + 10, filtered.length - 1);
        render();
      } else if (e.key === "PageUp") {
        e.preventDefault();
        index = Math.max(index - 10, 0);
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[index]) done(filtered[index]);
      }
    });
    const close = showModal(box, () => resolve(result));
    const done = (r: PickItem | null) => {
      result = r;
      close();
    };
    if (opts.initial) {
      input.value = opts.initial;
      filter();
    } else render();
    input.focus();
  });
}

function fuzzy(q: string, s: string): boolean {
  let i = 0;
  for (const c of s) {
    if (c === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

function score(q: string, s: string): number {
  const idx = s.indexOf(q);
  if (idx === 0) return 0;
  if (idx > 0) return 1 + idx / 100;
  return 10;
}

export function toast(text: string, ms = 2500): void {
  const el = h("div", { class: "toast" }, text);
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** Simple context menu at a screen position. */
export function contextMenu(x: number, y: number, items: ({ label: string; run: () => void; disabled?: boolean } | "-")[]): void {
  closeContextMenu();
  const menu = h("div", { class: "ctx-menu" });
  for (const it of items) {
    if (it === "-") {
      menu.append(h("div", { class: "ctx-sep" }));
      continue;
    }
    const row = h("div", { class: "ctx-item" + (it.disabled ? " disabled" : "") }, it.label);
    if (!it.disabled)
      row.addEventListener("click", () => {
        closeContextMenu();
        it.run();
      });
    menu.append(row);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  ctx = menu;
  setTimeout(() => {
    document.addEventListener("mousedown", onDocDown, { capture: true });
    document.addEventListener("keydown", onDocKey, { capture: true });
  }, 0);
}

let ctx: HTMLElement | null = null;
function onDocDown(e: MouseEvent) {
  if (ctx && !ctx.contains(e.target as Node)) closeContextMenu();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeContextMenu();
}
export function closeContextMenu(): void {
  if (ctx) {
    ctx.remove();
    ctx = null;
  }
  document.removeEventListener("mousedown", onDocDown, { capture: true });
  document.removeEventListener("keydown", onDocKey, { capture: true });
}
