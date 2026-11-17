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

for (const theme of ["nax-dark", "nax-light", "unix-terminal", "proton-purple"]) {
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
    // Body text, secondary controls and line numbers remain readable in each palette.
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

test("desktop appearance renders default and added themes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/ui/fixture.html");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await sampleDocument(page);
  await page.locator(".cm-content").first().press("Control+End");
  await page.locator(".cm-scroller").first().evaluate(el => el.scrollTop = 0);
  for (const theme of ["nax-dark", "nax-light", "unix-terminal", "proton-purple"]) {
    await page.evaluate(theme => (window as any).themes.applyTheme(theme), theme);
    await page.screenshot({ path: testInfo.outputPath(`${theme}.png`), animations: "disabled" });
  }
});

for (const language of ["en", "de"]) {
  test(`${language}: new themes can be selected and saved from Settings`, async ({ page }) => {
    await page.goto(`/tests/ui/fixture.html?language=${language}`);
    await expect(page.locator(".cm-content").first()).toBeVisible();
    await page.keyboard.press("Control+,");
    const chooser = page.getByRole("combobox", { name: language === "de" ? "Design" : "Theme", exact: true });
    await expect(chooser.locator('option[value="unix-terminal"]')).toHaveText(language === "de" ? "Unix-Terminal" : "Unix Terminal");
    await expect(chooser.locator('option[value="proton-purple"]')).toHaveText(language === "de" ? "Proton-Violett" : "Proton Purple");
    for (const [id, background] of [["unix-terminal", "#0b100d"], ["proton-purple", "#1c1730"]]) {
      await chooser.selectOption(id);
      await expect.poll(() => page.evaluate(() => (window as any).settingsWrites.at(-1)?.theme)).toBe(id);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())).toBe(background);
      expect(await page.locator(".titlebar").evaluate(el => getComputedStyle(el).backgroundImage)).toBe("none");
    }
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).__nax.run("view.theme"));
    await page.locator(".pick-row").filter({ hasText: language === "de" ? "Unix-Terminal" : "Unix Terminal" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).settingsWrites.at(-1)?.theme)).toBe("unix-terminal");
  });
}

test("icons keep distinct readable colors when switching between terminal, purple and light themes", async ({ page }) => {
  await page.goto("/tests/ui/fixture.html");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await sampleDocument(page);
  await page.evaluate(() => {
    const gallery = document.createElement("div");
    gallery.id = "icon-samples";
    for (const name of ["fileText", "fileMarkdown", "fileCode", "fileJson", "fileBinary", "fileImage"]) {
      gallery.append((window as any).icons.icon(name));
    }
    document.body.append(gallery);
  });
  for (const theme of ["unix-terminal", "proton-purple", "nax-light", "classic-dark", "unix-terminal"]) {
    await page.evaluate(theme => (window as any).themes.applyTheme(theme), theme);
    const colors = await page.locator("#icon-samples .ic").evaluateAll(els => els.map(el => getComputedStyle(el).color));
    expect(new Set(colors).size).toBe(6);
    const ratios = await page.evaluate(() => {
      const linear = (rgb: number[]) => {
        const c = rgb.map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
        return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
      };
      const bg = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      return [...document.querySelectorAll("#icon-samples .ic")].map(el => {
        const fg = getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        const [lo, hi] = [linear(fg), linear(bg)].sort((a, b) => a - b);
        return (hi + .05) / (lo + .05);
      });
    });
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(3);
    // Active tab and breadcrumb styles must not replace a file type's color with the theme accent.
    const markdownColor = colors[1];
    await expect(page.locator('.tab.active .ic[data-icon="fileMarkdown"]')).toHaveCSS("color", markdownColor);
    await expect(page.locator('.crumb-icon[data-icon="fileMarkdown"]')).toHaveCSS("color", markdownColor);
  }
  await page.locator(".tb-win.close").hover();
  await expect(page.locator(".tb-win.close .ic")).toHaveCSS("color", "rgb(255, 255, 255)");
});
