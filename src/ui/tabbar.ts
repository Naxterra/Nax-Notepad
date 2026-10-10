import { App, Tab } from "../app";
import { backend } from "../backend";
import { contextMenu, h, toast } from "./dialogs";

export function mountTabBar(app: App, root: HTMLElement): void {
  const strip = h("div", { class: "tab-strip" });
  const addBtn = h("button", { class: "tab-add", title: "New tab (Ctrl+N)", click: () => app.newTab() }, "+");
  root.append(strip, addBtn);

  let dragging: Tab | null = null;

  const render = () => {
    strip.replaceChildren();
    for (const tab of app.tabs) {
      const el = h(
        "div",
        {
          class: "tab" + (tab === app.active ? " active" : "") + (tab.dirty ? " dirty" : "") + (tab.pinned ? " pinned" : ""),
          title: tab.path ?? tab.name,
          draggable: "true",
        },
        h("span", { class: "tab-name" }, tab.name),
        h("span", { class: "tab-dot" }, "●"),
        h(
          "button",
          {
            class: "tab-close",
            title: "Close (Ctrl+W)",
            click: (e) => {
              e.stopPropagation();
              void app.closeTab(tab);
            },
          },
          "×"
        )
      );
      el.addEventListener("mousedown", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          void app.closeTab(tab);
        } else if (e.button === 0) app.activate(tab);
      });
      el.addEventListener("auxclick", (e) => e.preventDefault());
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: "Close", run: () => void app.closeTab(tab) },
          { label: "Close others", run: () => void app.closeOthers(tab) },
          { label: "Close all", run: () => void app.closeAll() },
          { label: "Close to the right", run: () => void app.closeToRight(tab) },
          "-",
          { label: tab.pinned ? "Unpin tab" : "Pin tab", run: () => app.togglePinned(tab) },
          { label: tab.readOnly ? "Clear read-only" : "Set read-only", run: () => app.setReadOnly(tab, !tab.readOnly) },
          "-",
          {
            label: "Copy full path",
            disabled: !tab.path,
            run: () => {
              void navigator.clipboard.writeText(tab.path ?? "");
              toast("Path copied");
            },
          },
          {
            label: "Copy file name",
            run: () => {
              void navigator.clipboard.writeText(tab.name);
              toast("Name copied");
            },
          },
          { label: "Reveal in Explorer", disabled: !tab.path, run: () => void backend.revealInExplorer(tab.path!) },
          { label: "Reload from disk", disabled: !tab.path, run: () => void app.reload(tab) },
        ]);
      });
      el.addEventListener("dragstart", (e) => {
        dragging = tab;
        e.dataTransfer?.setData("text/plain", tab.id);
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => {
        dragging = null;
        el.classList.remove("dragging");
        strip.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      });
      el.addEventListener("dragover", (e) => {
        if (!dragging || dragging === tab) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        el.classList.toggle("drop-before", before);
        el.classList.toggle("drop-after", !before);
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
      el.addEventListener("drop", (e) => {
        if (!dragging || dragging === tab) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        let idx = app.tabs.indexOf(tab);
        const from = app.tabs.indexOf(dragging);
        if (from < idx) idx -= 1;
        app.moveTab(dragging, before ? idx : idx + 1);
      });
      strip.append(el);
    }
    const active = strip.querySelector(".tab.active") as HTMLElement | null;
    active?.scrollIntoView({ inline: "nearest", block: "nearest" });
  };

  strip.addEventListener("wheel", (e) => {
    if (e.deltaY !== 0 && !e.shiftKey) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
  strip.addEventListener("dblclick", (e) => {
    if (e.target === strip) app.newTab();
  });

  app.on("tabs", render);
  render();
}
