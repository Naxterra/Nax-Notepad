import { expect, test, type Page } from "@playwright/test";

async function sampleDocument(page: Page) {
  await page.evaluate(async () => {
    const { app } = (window as any).__nax;
    app.active.name = "settings.json";
    const tab = app.newTab([
      "# A little room to think", "", "Notes, ideas, and the next thing to build.", "",
      "## A quieter workspace", "", "Keep the focus on your words. A few small details make the difference:", "",
      "- Comfortable spacing and clear type", "- Everything you need, close at hand",
      "- Your work, right where you left it", "", "## On the list", "",
      "- [x] Gather the first ideas", "- [x] Make space for the details", "- [ ] Write the next chapter", "",
      "> Good tools leave room for the work.", "", "---", "", "One thought at a time.",
    ].join("\n"));
    tab.name = "Notes.md";
    tab.path = "workspace/Notes.md";
    await app.setLanguage(tab, "Markdown");
    app.emit("tabs");
  });
}

for (const theme of ["nax-dark", "nax-light"]) {
  test(`${theme}: readable surfaces and toolbar controls fit a narrow window`, async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 600 });
    await page.goto("/tests/ui/fixture.html?language=de");
    await expect(page.locator(".cm-content").first()).toBeVisible();
    await sampleDocument(page);
    await page.evaluate(theme => (window as any).themes.applyTheme(theme), theme);
    const controls = page.locator(".doc-controls").first();
    for (const button of await controls.locator("button").all()) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
    expect(await page.locator(".pane").first().evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator(".tb-win.close").evaluate(el => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    // Body text, secondary controls and line numbers remain readable in both defaults.
    const contrast = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const luma = (hex: string) => {
        const rgb = hex.trim().slice(1).match(/../g)!.map(x => parseInt(x, 16) / 255)
          .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const ratio = (a: string, b: string) => {
        const [lo, hi] = [luma(css.getPropertyValue(a)), luma(css.getPropertyValue(b))].sort((a, b) => a - b);
        return (hi + .05) / (lo + .05);
      };
      return [ratio("--fg", "--bg"), ratio("--fg-muted", "--chrome-bg"), ratio("--gutter-fg", "--gutter-bg")];
    });
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
}

test("both split panes retain usable toolbars and editor height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/ui/fixture.html?language=de");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await sampleDocument(page);
  await page.evaluate(async () => {
    const { app } = (window as any).__nax;
    await app.cloneToOtherView(app.active);
  });
  await expect(page.locator(".doc-toolbar:visible")).toHaveCount(2);
  await expect(page.locator(".pane.focused")).toHaveCount(1);
  await expect(page.locator(".pane").nth(1)).toHaveClass(/focused/);
  for (const pane of await page.locator(".pane").all()) {
    expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await pane.locator(".cm-editor").boundingBox())!.height).toBeGreaterThan(400);
    const controls = pane.locator(".doc-controls");
    for (const button of await controls.locator("button").all()) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
  }
  // Moving focus and closing a split must affect the outer panes, not just their body.
  await page.locator(".pane").first().locator(".cm-content").click();
  await expect(page.locator(".pane").first()).toHaveClass(/focused/);
  await page.evaluate(() => (window as any).__nax.app.closeSplit());
  await expect(page.locator(".doc-toolbar:visible")).toHaveCount(1);
  await expect(page.locator(".pane").nth(1)).toBeHidden();
});

test("settings stay reachable on a short window and reduced motion is respected", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 320 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/ui/fixture.html");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  expect(await dialog.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  await close.click();
  await expect(dialog).toHaveCount(0);
});

test("desktop appearance renders in both default themes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/ui/fixture.html");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await sampleDocument(page);
  await page.locator(".cm-content").first().press("Control+End");
  await page.locator(".cm-scroller").first().evaluate(el => el.scrollTop = 0);
  for (const theme of ["nax-dark", "nax-light"]) {
    await page.evaluate(theme => (window as any).themes.applyTheme(theme), theme);
    await page.screenshot({ path: testInfo.outputPath(`${theme}.png`), animations: "disabled" });
  }
});
