import { App, Tab } from "../app";
import { backend } from "../backend";
import { writeClipboard } from "../clipboard";
import { contextMenu, h, toast } from "./dialogs";
import { fileIcon, icon } from "./icons";
import { t } from "../i18n";

/** Tab bar of one pane. Tabs can be dragged within the bar or onto the other pane's bar. */
let dragging: Tab | null = null;

export function mountTabBar(app: App, root: HTMLElement, pane: 0 | 1): void {
  const strip = h("div", { class: "tab-strip" });
  const addBtn = h(
    "button",
    {
      class: "tab-add",
      title: t("New tab (Ctrl+N)"),
      click: () => {
        if (app.splitOn) app.focusPane(pane, false);
        app.newTab();
      },
    },
    icon("plus")
  );
  root.append(strip, addBtn);

  const render = () => {
    strip.replaceChildren();
    const shown = app.panes[pane]?.tab;
    for (const tab of app.tabsIn(pane)) {
      const own = app.owner(tab);
      const el = h(
        "div",
        {
          class: "tab" + (tab === shown ? " active" : "") + (own.dirty ? " dirty" : "") + (tab.pinned ? " pinned" : "") + (tab.cloneOf ? " clone" : "") + (own.tail ? " following" : ""),
          title: (own.path ?? own.name) + (tab.cloneOf ? ` (${t("clone")})` : ""),
          draggable: "true",
        },
        icon(own.hexView && !own.path ? "fileBinary" : fileIcon(own.name), "tab-icon"),
        h("span", { class: "tab-name" }, own.name),
        h("span", { class: "tab-dot" }, "●"),
        h(
          "button",
          {
            class: "tab-close",
            title: t("Close (Ctrl+W)"),
            click: (e) => {
              e.stopPropagation();
              void app.closeTab(tab);
            },
          },
          icon("close")
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
          { label: t("Close"), run: () => void app.closeTab(tab) },
          { label: t("Close others"), run: () => void app.closeOthers(tab) },
          { label: t("Close all"), run: () => void app.closeAll() },
          { label: t("Close to the right"), run: () => void app.closeToRight(tab) },
          "-",
          { label: t("Move to Other View"), run: () => app.moveToOtherView(tab) },
          { label: t("Clone to Other View"), run: () => void app.cloneToOtherView(tab), disabled: own.kind === "paged" },
          "-",
          { label: tab.pinned ? t("Unpin tab") : t("Pin tab"), run: () => app.togglePinned(tab) },
          { label: own.readOnly ? t("Clear read-only") : t("Set read-only"), run: () => app.setReadOnly(tab, !own.readOnly) },
          { label: own.tail ? t("Stop following") : t("Follow File Changes (tail -f)"), run: () => void app.toggleFollow(tab), disabled: !own.path },
          "-",
          {
            label: t("Copy full path"),
            disabled: !own.path,
            run: () => {
              void writeClipboard(own.path ?? "");
              toast(t("Path copied"));
            },
          },
          {
            label: t("Copy file name"),
            run: () => {
              void writeClipboard(own.name);
              toast(t("Name copied"));
            },
          },
          { label: t("Reveal in Explorer"), disabled: !own.path, run: () => void backend.revealInExplorer(own.path!) },
          { label: t("Reload from disk"), disabled: !own.path, run: () => void app.reload(tab) },
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
        document.querySelectorAll(".drop-before,.drop-after,.drop-target").forEach((x) => x.classList.remove("drop-before", "drop-after", "drop-target"));
      });
      el.addEventListener("dragover", (e) => {
        if (!dragging || dragging === tab) return;
        e.preventDefault();
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        el.classList.toggle("drop-before", before);
        el.classList.toggle("drop-after", !before);
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
      el.addEventListener("drop", (e) => {
        if (!dragging || dragging === tab) return;
        e.preventDefault();
        e.stopPropagation();
        const moving = dragging;
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        if (app.paneIndex(moving) !== pane) app.moveToOtherView(moving);
        let idx = app.tabs.indexOf(tab);
        const from = app.tabs.indexOf(moving);
        if (from < 0 || idx < 0) return;
        if (from < idx) idx -= 1;
        app.moveTab(moving, before ? idx : idx + 1);
      });
      strip.append(el);
    }
    const active = strip.querySelector(".tab.active") as HTMLElement | null;
    active?.scrollIntoView({ inline: "nearest", block: "nearest" });
  };

  // Dropping on the empty part of the bar moves the tab to the end of this pane.
  root.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    root.classList.add("drop-target");
  });
  root.addEventListener("dragleave", () => root.classList.remove("drop-target"));
  root.addEventListener("drop", (e) => {
    root.classList.remove("drop-target");
    if (!dragging) return;
    e.preventDefault();
    const moving = dragging;
    if (app.paneIndex(moving) !== pane) app.moveToOtherView(moving);
    else app.moveTab(moving, app.tabs.length);
  });

  strip.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY !== 0 && !e.shiftKey) {
        strip.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false }
  );
  strip.addEventListener("dblclick", (e) => {
    if (e.target !== strip) return;
    if (app.splitOn) app.focusPane(pane, false);
    app.newTab();
  });

  app.on("tabs", render);
  app.on("active", render);
  app.on("layout", render);
  render();
}
