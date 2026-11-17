import { expect, test, type Page } from "@playwright/test";

async function openBytes(page: Page, size = 1024 * 1024, delayed = false, language = "en") {
  await page.goto(`/tests/ui/fixture.html?language=${language}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.waitForFunction(() => (window as any).hexBuffer);
  await page.evaluate(async ({ size, delayed }) => {
    const w = window as any;
    const { app, updateSettings } = w.__nax;
    updateSettings({ theme: "proton-purple", fontSize: 12, inspectorVisible: true });
    w.byteReads = [];
    const gate = delayed ? new Promise<void>(resolve => w.releaseReads = resolve) : Promise.resolve();
    const source = {
      size,
      read: async (offset: number, len: number) => {
        w.byteReads.push(len);
        await gate;
        return Uint8Array.from({ length: len }, (_, i) => (offset + i) % 256);
      },
    };
    const tab = app.active;
    Object.assign(tab, { name: "sample.bin", path: "sample.bin", size, mtime: 1, revision: 0, savedRevision: 0, dirty: false });
    tab.hex = await w.hexBuffer.HexBuffer.load(source, 0); // sparse even for the small test file
    tab.hexKey = `file:sample.bin:${size}:1`;
    await app.setViewMode(tab, "hex");
  }, { size, delayed });
  await expect(page.locator(".hex-root").first()).toBeVisible();
}

const rowCount = (page: Page) => page.locator(".hex-body .hx-row").first().locator(".hx-b").count();
const state = (page: Page) => page.evaluate(() => (window as any).__nax.hexes[0].state);

test("Auto fills the hex view, aligns byte groups and adapts when the inspector is collapsed", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBytes(page);
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(24);
  const before = await rowCount(page);
  await expect(page.locator(".hex-title-text").first()).toHaveText(`Hex · ${before} bytes per row`);
  const scroller = (await page.locator(".hex-scroller").first().boundingBox())!;
  const row = (await page.locator(".hex-body .hx-row").first().boundingBox())!;
  expect(row.width / scroller.width).toBeGreaterThan(.72);
  expect(row.x + row.width).toBeLessThanOrEqual(scroller.x + scroller.width);
  const byte0 = (await page.locator('.hx-b[data-o="0"]').boundingBox())!;
  const nextRow = (await page.locator(`.hx-b[data-o="${before}"]`).boundingBox())!;
  expect(Math.abs(byte0.x - nextRow.x)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath("auto-hex.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Hide the inspector", exact: true }).click();
  await expect.poll(() => rowCount(page)).toBeGreaterThan(before);
  await expect(page.getByRole("button", { name: "Show the inspector", exact: true })).toBeVisible();
  const expanded = await rowCount(page);
  await page.evaluate(() => (window as any).__nax.updateSettings({ fontSize: 20 }));
  await expect.poll(() => rowCount(page)).toBeLessThan(expanded);
});

test("row width controls remain usable in a narrow German window", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 650 });
  await openBytes(page, 1024, false, "de");
  const chooser = page.getByRole("combobox", { name: "Bytes pro Zeile", exact: true });
  await expect(chooser).toBeInViewport();
  await expect(chooser.locator('option[value="0"]')).toHaveText("Automatisch");
  await page.getByRole("button", { name: "Inspektor ausblenden", exact: true }).click();
  await chooser.selectOption("16");
  await expect.poll(() => rowCount(page)).toBe(16);
  await expect(page.locator(".hex-title-text").first()).toHaveText("Hex · 16 Bytes pro Zeile");
});

test("fixed row widths preserve byte selection, navigation and edits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openBytes(page);
  const chooser = page.getByRole("combobox", { name: "Bytes per row", exact: true });
  await chooser.selectOption("32");
  await expect.poll(() => rowCount(page)).toBe(32);
  await page.evaluate(() => (window as any).__nax.hexes[0].setSelection(40, 57));
  await chooser.selectOption("64");
  await expect.poll(() => rowCount(page)).toBe(64);
  expect(await state(page)).toMatchObject({ cursor: 56, from: 40, to: 57 });
  await page.setViewportSize({ width: 900, height: 800 });
  expect(await state(page)).toMatchObject({ cursor: 56, from: 40, to: 57 });
  await chooser.selectOption("32");
  await expect.poll(() => rowCount(page)).toBe(32);
  const scroller = page.locator(".hex-scroller").first();
  await scroller.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  expect(await state(page)).toMatchObject({ cursor: 32 });
  await page.keyboard.press("End");
  expect(await state(page)).toMatchObject({ cursor: 63 });
  await page.keyboard.press("Home");
  expect(await state(page)).toMatchObject({ cursor: 32 });
  await page.keyboard.press("Shift+ArrowDown");
  expect(await state(page)).toMatchObject({ cursor: 64, from: 32, to: 65 });
  await chooser.selectOption("16");
  await expect.poll(() => rowCount(page)).toBe(16);
  expect(await state(page)).toMatchObject({ cursor: 64, from: 32, to: 65 });
  await page.evaluate(() => (window as any).__nax.hexes[0].setSelection(50, 50));
  await scroller.focus();
  await page.keyboard.type("a5");
  expect(await page.evaluate(() => (window as any).__nax.hexes[0].buffer.patchList())).toEqual([[50, 0xa5]]);
  await page.keyboard.press("Control+z");
  expect(await page.evaluate(() => (window as any).__nax.hexes[0].buffer.byteAt(50))).toBe(50);
  await expect.poll(() => page.evaluate(() => (window as any).settingsWrites.at(-1)?.hexBytesPerRow)).toBe(16);
});

test("resizing a sparse multi-terabyte view keeps its scrolled byte range and bounded reads", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openBytes(page, 2 ** 42, true);
  await expect.poll(() => page.evaluate(() => (window as any).byteReads.length)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1900, height: 800 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => (window as any).releaseReads());
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(32);
  const rows = await rowCount(page);
  await expect(page.locator(".hex-title-text").first()).toHaveText(`Hex · ${rows} bytes per row`);
  const scroller = page.locator(".hex-scroller").first();
  await scroller.evaluate(el => el.scrollTop = (el.scrollHeight - el.clientHeight) / 2);
  const topOffset = () => page.locator(".hex-body .hx-off").first().textContent().then(text => parseInt(text!, 16));
  await expect.poll(topOffset).toBeGreaterThan(2 ** 40);
  const before = await topOffset();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(() => rowCount(page)).toBeLessThan(rows);
  expect(Math.abs((await topOffset()) - before)).toBeLessThanOrEqual(64);
  expect(await state(page)).toMatchObject({ cursor: 0 }); // scrolling must not jump back to the caret
  const reads = await page.evaluate(() => (window as any).byteReads as number[]);
  expect(Math.max(...reads)).toBeLessThanOrEqual(64 * 1024);
  expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(1024 * 1024);
});
