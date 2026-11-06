import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/ui/fixture.html");
  await expect(page.locator(".cm-content").first()).toBeVisible();
});

test("Enter respects the focused Cancel and Don't save buttons", async ({ page }) => {
  for (const [method, label, expected] of [
    ["confirmDialog", "Cancel", false],
    ["confirm3", "Don't save", "no"],
    ["prompt", "Cancel", null],
  ] as const) {
    await page.evaluate((method) => {
      const w = window as any;
      w.result = "pending";
      void w.dialogs[method]("Confirm", "Keep changes?").then((r: unknown) => w.result = r);
    }, method);
    await page.getByRole("button", { name: label, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).result)).toBe(expected);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("replacing a confirmation resolves cancellation and closing is idempotent", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.result = "pending";
    void w.dialogs.confirm3("Old dialog", "Save changes?").then((r: string) => w.result = r);
    w.modalCloseCount = 0;
    w.dismiss = w.dialogs.showModal(w.dialogs.h("div", { class: "modal" }), () => w.modalCloseCount++);
  });
  await expect.poll(() => page.evaluate(() => (window as any).result)).toBe("cancel");
  await page.evaluate(() => {
    const w = window as any;
    w.dialogs.closeModal();
    w.dismiss();
    w.dialogs.closeModal();
  });
  expect(await page.evaluate(() => (window as any).modalCloseCount)).toBe(1);
});

test("dialogs trap Tab and restore the editor focus without leaking Escape", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.fill("unchanged");
  await page.evaluate(() => {
    const w = window as any;
    w.result = "pending";
    void w.dialogs.confirm3("Save document", "Keep changes?").then((r: string) => w.result = r);
  });
  await expect(page.getByRole("dialog", { name: "Save document" })).toBeVisible();
  const save = page.getByRole("button", { name: "Save", exact: true });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(save).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => (window as any).result)).toBe("cancel");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("unchanged");
});

test("closing a prompt explicitly settles its promise", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.result = "pending";
    void w.dialogs.prompt("Rename", "Name").then((r: string | null) => w.result = r);
    w.dialogs.closeModal();
  });
  await expect.poll(() => page.evaluate(() => (window as any).result)).toBe(null);
});
