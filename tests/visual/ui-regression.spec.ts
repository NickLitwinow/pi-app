import { expect, test, type Page } from "@playwright/test";

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Настройки" })).toBeVisible();
  await page.addStyleTag({
    content: `
      *, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }
      ::-webkit-scrollbar { visibility: hidden !important; }
      .dot.live, .stream-caret { animation: none !important; }
    `,
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const selectors = ["button", "input", "select", ".card", ".settings-group", ".app-modal", ".mk-card"];
    const escaped = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, text: (element.textContent ?? "").trim().slice(0, 80), left: rect.left, right: rect.right };
      })
      .filter((item) => item.left < -1 || item.right > viewport + 1);
    return { viewport, documentWidth: document.documentElement.scrollWidth, escaped };
  });
  expect(result.documentWidth, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(result.viewport + 1);
  expect(result.escaped, JSON.stringify(result, null, 2)).toEqual([]);
}

test("Settings / Interface — ChatGPT preset", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByRole("button", { name: /^Интерфейс/ }).click();
  await expect(page.getByRole("heading", { name: "Интерфейс" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("settings-interface-chatgpt.png", { fullPage: true });
});

test("Settings / Interface — Custom keeps button and icon colors independent", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByRole("button", { name: /^Интерфейс/ }).click();
  await page.getByRole("button", { name: /Custom color/ }).click();
  const accent = page.getByLabel("Выбрать цвет кнопок");
  const icons = page.getByLabel("Выбрать цвет иконок");
  await expect(accent).toBeVisible();
  await expect(icons).toBeVisible();
  await accent.fill("#f4f4f4");
  await icons.fill("#4aa8ff");
  await expect(page.locator("html")).toHaveCSS("--brand-button", "#f4f4f4");
  await expect(page.locator("html")).toHaveCSS("--icon-accent", "#4aa8ff");
  await expectNoHorizontalOverflow(page);
});

test("Settings / Interface — minimalist app icon background is independent and customizable", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByRole("button", { name: /^Интерфейс/ }).click();
  const iconBackgrounds = page.getByRole("group", { name: "Фон иконки приложения" });
  await iconBackgrounds.scrollIntoViewIfNeeded();
  await expect(iconBackgrounds).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-app-icon-background", "#171A24");
  const previewTile = iconBackgrounds.locator("[data-app-icon-tile]").first();
  await expect(previewTile).toHaveAttribute("x", "6.25");
  await expect(previewTile).toHaveAttribute("width", "51.5");
  await expect(previewTile).toHaveAttribute("rx", "11.56");

  await page.getByRole("button", { name: "Фон иконки: Cobalt" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-app-icon-background", "#2563D9");
  await page.getByRole("button", { name: "Gemini" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-app-icon-background", "#2563D9");

  await page.getByLabel("Выбрать фон иконки приложения").fill("#f3f1ea");
  await expect(page.locator("html")).toHaveAttribute("data-app-icon-background", "#F3F1EA");
  await expectNoHorizontalOverflow(page);
  await expect(page.locator(".app-icon-style-section")).toHaveScreenshot("settings-icon-styles.png");
});

test("Settings raw editor keeps a newer draft when an older reread finishes late", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const editor = page.locator("details.advanced-editor").filter({ hasText: "Advanced · raw settings.json" });
  await editor.locator("summary").click();
  const textarea = editor.locator("textarea");
  await expect(textarea).not.toHaveValue("");

  await editor.getByRole("button", { name: "Перечитать" }).click();
  const newerDraft = '{\n  "draft": "user edit must win"\n}';
  await textarea.fill(newerDraft);
  await page.waitForTimeout(140);
  await expect(textarea).toHaveValue(newerDraft);
  await expect(editor.getByText("Не сохранено", { exact: true })).toBeVisible();
});

test("Settings serializes rapid nested updates without dropping sibling values", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const autoResize = page.getByRole("switch", { name: "Автоматически уменьшать большие изображения" });
  const blockImages = page.getByRole("switch", { name: "Не отправлять изображения провайдерам" });
  await expect(autoResize).toHaveAttribute("aria-checked", "true");
  await expect(blockImages).toHaveAttribute("aria-checked", "false");

  await autoResize.click();
  await blockImages.click();
  await expect(autoResize).toHaveAttribute("aria-checked", "false");
  await expect(blockImages).toHaveAttribute("aria-checked", "true");

  const editor = page.locator("details.advanced-editor").filter({ hasText: "Advanced · raw settings.json" });
  await editor.locator("summary").click();
  await editor.getByRole("button", { name: "Перечитать" }).click();
  await expect.poll(async () => {
    const value = await editor.locator("textarea").inputValue();
    const settings = JSON.parse(value) as { images?: { autoResize?: boolean; blockImages?: boolean } };
    return settings.images;
  }).toEqual({ autoResize: false, blockImages: true });
});

test("Library / Extensions — long scoped package and responsive actions", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: /^Расширения/ }).click();
  await expect(page.getByText("@gotgenes/pi-permission-system", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("extensions-responsive.png", { fullPage: true });
});

test("Library ignores stale catalogs and covers the installed browser extensions", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: /^Skills/ }).click();
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  await expect(page.getByText("mitsupi", { exact: true })).toBeVisible();
  // The mock Extensions request deliberately resolves later than Skills.
  // It must not replace the visible Skills catalog after the tab switch.
  await page.waitForTimeout(500);
  await expect(page.getByText("mitsupi", { exact: true })).toBeVisible();
  await expect(page.getByText("pi-lens", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /^Расширения/ }).click();
  await page.getByRole("button", { name: "Установленные", exact: true }).click();
  await expect(page.getByText("Пакеты с ресурсом «расширения»: 14", { exact: true })).toBeVisible();
  await expect(page.getByText("pi-chrome", { exact: true })).toBeVisible();
  await expect(page.getByText("pi-agent-browser-native", { exact: true })).toBeVisible();
});

test("Library installed view only lists packages that declare the selected resource", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: /^Skills/ }).click();
  await page.getByRole("button", { name: "Установленные" }).click();
  await expect(page.getByText("Пакеты с ресурсом «skills»: 2", { exact: true })).toBeVisible();
  await expect(page.getByText("pi-web-access", { exact: true })).toBeVisible();
  await expect(page.getByText("ponytail", { exact: true })).toBeVisible();
  await expect(page.getByText("pi-mcp-adapter", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Resolved skills · 3", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Открыть skill code-review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Открыть skill librarian" })).toContainText("package · pi-web-access");
  await expect(page.getByRole("button", { name: "Открыть skill ship" })).toContainText("Только /skill");

  await page.getByRole("button", { name: /^Темы/ }).click();
  await expect(page.getByText("Пакеты с ресурсом «темы»: 0", { exact: true })).toBeVisible();
  await expect(page.getByText("Пакетов с ресурсами этого типа нет", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Prompts/ }).click();
  await expect(page.getByText("Пакеты с ресурсом «prompts и AGENTS.md»: 0", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Расширения/ }).click();
  await expect(page.getByText("Пакеты с ресурсом «расширения»: 14", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Skills/ }).click();
  await page.getByRole("button", { name: "Текущий проект" }).click();
  await expect(page.getByText("Пакеты с ресурсом «skills»: 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Открыть skill project-audit" })).toContainText("auto-discovery");
  const projectSkill = page.locator(".mk-card").filter({ hasText: "pi-skill-code-review" });
  await expect(projectSkill.getByRole("button", { name: "Активно" })).toBeVisible();
  await projectSkill.getByRole("button", { name: "Активно" }).click();
  await expect(projectSkill.getByRole("button", { name: "Выключено" })).toBeVisible();
  await page.getByRole("button", { name: "Все проекты" }).click();
  await page.getByRole("button", { name: "Текущий проект" }).click();
  await expect(projectSkill.getByRole("button", { name: "Выключено" })).toBeVisible();

  await page.getByRole("button", { name: "Выбрать проект «website»" }).click();
  await expect(page.getByText("Пакеты с ресурсом «skills»: 0", { exact: true })).toBeVisible();
  await expect(page.getByText("Пакетов с ресурсами этого типа нет", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Выбрать проект «pi-app»" }).click();
  await expect(page.getByText("Пакеты с ресурсом «skills»: 1", { exact: true })).toBeVisible();
  await expect(projectSkill.getByRole("button", { name: "Выключено" })).toBeVisible();
});

test("Sidebar session CRUD stays scoped to its workspace", async ({ page }) => {
  await boot(page);
  const projects = page.locator(".proj");
  const piProject = projects.nth(0);
  const websiteProject = projects.nth(1);

  await websiteProject.locator(".proj-head").click();
  await expect(websiteProject.locator(".sess-row[aria-label^='Открыть сессию']")).toHaveCount(2);
  await expect(websiteProject.getByText("Landing page accessibility", { exact: true })).toBeVisible();
  await expect(websiteProject.getByText("Deploy preview", { exact: true })).toBeVisible();
  await expect(websiteProject.getByText("Fix supervisor race", { exact: true })).toHaveCount(0);

  const sessionActions = piProject.getByRole("button", { name: "Действия с сессией «Fix supervisor race»" });
  await sessionActions.click();
  await piProject.getByRole("button", { name: "Переименовать" }).click();
  const rename = piProject.getByRole("textbox", { name: "Новое имя сессии «Fix supervisor race»" });
  await rename.fill("Supervisor lifecycle audit");
  await rename.press("Enter");
  await expect(piProject.getByRole("button", { name: "Открыть сессию «Supervisor lifecycle audit»" })).toBeVisible();

  const renamedActions = piProject.getByRole("button", { name: "Действия с сессией «Supervisor lifecycle audit»" });
  await renamedActions.click();
  await piProject.getByRole("button", { name: "Закрепить" }).click();
  await renamedActions.click();
  await expect(piProject.getByRole("button", { name: "Открепить" })).toBeVisible();
  await piProject.getByRole("button", { name: "В группу… ›" }).click();
  const groupName = piProject.getByRole("textbox", { name: "Название новой группы" });
  await groupName.fill("Lifecycle");
  await groupName.press("Enter");
  await expect(piProject.getByRole("button", { name: "Свернуть группу «Lifecycle»" })).toContainText("1");

  await renamedActions.click();
  await piProject.getByRole("button", { name: "Архивировать" }).click();
  await expect(piProject.getByRole("button", { name: "Архив (1)" })).toBeVisible();
  await piProject.getByRole("button", { name: "Архив (1)" }).click();
  await renamedActions.click();
  await piProject.getByRole("button", { name: "Разархивировать" }).click();
  await expect(piProject.getByRole("button", { name: "Свернуть группу «Lifecycle»" })).toContainText("1");

  await renamedActions.click();
  await piProject.getByRole("button", { name: "Форк сессии" }).click();
  const fork = piProject.getByRole("button", { name: "Открыть сессию «Форк: s1»" });
  await expect(fork).toBeVisible();
  await piProject.getByRole("button", { name: "Действия с сессией «Форк: s1»" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await piProject.getByRole("button", { name: "Удалить" }).click();
  await expect(fork).toHaveCount(0);

  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Чат", exact: true }).click();
  await expect(piProject.getByRole("button", { name: "Свернуть группу «Lifecycle»" })).toContainText("1");
});

test("Active workflow protects permission mode and project detachment", async ({ page }) => {
  await boot(page);
  const composer = page.locator(".composer textarea");
  await composer.fill("[mock-workflow] protect the live workspace");
  await composer.press("Enter");
  await expect(page.getByRole("region", { name: "Workflow control center" })).toBeVisible();
  await expect(page.getByRole("button", { name: "⌁ Ask permissions" })).toBeDisabled();

  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Действия с проектом «pi-app»" }).click();
  await page.getByRole("button", { name: "Открепить от сайдбара" }).click();
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[1]).toContain("сначала остановите");
  await expect(page.getByRole("button", { name: "Проект «pi-app»" })).toBeVisible();
});

test("Themes marketplace state", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: /^Темы/ }).click();
  await expect(page.getByText("pi-theme-aurora", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("themes-marketplace.png", { fullPage: true });
});

test("Theme editor — live application palette", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByRole("button", { name: /^Редактор тем/ }).click();
  await page.getByRole("button", { name: "Создать тему" }).click();
  await expect(page.getByText("Редактор темы", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("--brand", "#10a37f");
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("theme-editor.png", { fullPage: true });
});

test("Update Center — portal and package update state", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Обновления" }).click();
  await expect(page.getByText("Центр обновлений", { exact: true })).toBeVisible();
  await expect(page.locator("body > .app-modal-overlay")).toHaveCount(1);
  await expect(page.locator(".update-package-row")).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("update-center.png", { fullPage: true });
});

test("Code Review — tabs and spacing", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Code Review" }).click();
  await expect(page.getByRole("button", { name: /Изменения/ })).toBeVisible();
  await expect(page.getByText("src/lib/reducer.ts", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("code-review.png", { fullPage: true });
});

test("Code Review ignores the previous workspace after a fast project switch", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Code Review" }).click();
  await page.getByRole("button", { name: "Выбрать проект «website»" }).click();
  await expect(page.getByText("src/site.css", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /website-main/ })).toBeVisible();
  // pi-app deliberately resolves later; its branch and files must stay detached.
  await page.waitForTimeout(300);
  await expect(page.getByText("src/site.css", { exact: true })).toBeVisible();
  await expect(page.getByText("src/lib/reducer.ts", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /website-main/ })).toBeVisible();
});

test("Compact 150% layout keeps controls inside viewport", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("#root");
    if (!root) return;
    root.style.transform = "scale(1.5)";
    root.style.transformOrigin = "0 0";
    root.style.width = `${100 / 1.5}%`;
    root.style.height = `${100 / 1.5}%`;
  });
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: /^Расширения/ }).click();
  await expect(page.getByText("@gotgenes/pi-permission-system", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("extensions-150-percent.png", { fullPage: true });
});

test("Library harness profiles — context cost and scope", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: /^Профили/ }).click();
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(page.getByText("≈4.2K токенов + lazy Ponytail skills · auto-name thinking off", { exact: true })).toBeVisible();
  await expect(page.getByText("ponytail", { exact: true })).toBeVisible();
  await page.getByText("Local reasoning boost", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Включить boost" }).click();
  await expect(page.getByRole("button", { name: "Выключить boost" })).toBeVisible();
  await expect(page.locator(".profile-console")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("library-profiles.png", { fullPage: true });
});

test("Sequential thinking — native collapsible thought card", async ({ page }) => {
  await boot(page);
  await page.locator(".sess-row", { hasText: "Старый рефакторинг" }).click();
  // завершённый ход свёрнут (Codex-стиль): мысли живут внутри «Worked for»
  await expect(page.getByText("Мысль 3/7", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Worked for/ }).click();
  await expect(page.getByText("Мысль 3/7", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Мысль 3\/7/ }).click();
  await expect(page.getByText("Следующий шаг нужен", { exact: true })).toBeVisible();
  await expect(page.getByText(/\"thoughtNumber\"/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("sequential-thinking-card.png", { fullPage: true });
});

test("Transcript mode menu stays open across the trigger gap", async ({ page }) => {
  await boot(page);
  const trigger = page.getByRole("button", { name: "Normal", exact: true });
  await trigger.click();
  const menu = page.getByRole("listbox", { name: "Режим ленты" });
  await expect(menu).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  await page.mouse.move(triggerBox!.x + triggerBox!.width / 2, triggerBox!.y + triggerBox!.height / 2);
  await page.mouse.move(menuBox!.x + menuBox!.width / 2, menuBox!.y + menuBox!.height / 2, { steps: 10 });
  await expect(menu).toBeVisible();
  await page.getByRole("option", { name: /Summary/ }).click();
  await expect(page.getByRole("button", { name: "Summary", exact: true })).toBeVisible();
});

test("Post-run summary — stable stream, collapsed actions and changed files", async ({ page }) => {
  await boot(page);
  const composer = page.locator(".composer textarea");
  await composer.fill("Сделай цепочку правок");
  await composer.press("Enter");

  const streaming = page.locator(".msg.streaming");
  await expect(streaming).toBeVisible();
  const streamingNode = await streaming.elementHandle();
  expect(streamingNode).not.toBeNull();
  await page.waitForTimeout(140);
  expect(await streamingNode!.evaluate((element) => element.isConnected)).toBe(true);

  await page.getByRole("button", { name: "Заблокировать" }).click();
  const worked = page.getByRole("button", { name: /Worked for/ });
  await expect(worked).toBeVisible();
  await expect(page.getByText("Edited 2 files", { exact: true })).toBeVisible();
  await expect(page.locator(".run-summary .toolcard")).toHaveCount(0);
  await worked.click();
  await expect(page.locator(".run-summary .toolcard")).toHaveCount(2);
  await page.locator(".run-files-card").getByRole("button", { name: /Review/ }).click();
  await expect(page.getByRole("button", { name: "Чекпоинты агента" })).toHaveClass(/active/);
  await expect(page.getByTitle("База сравнения")).toHaveValue("abc1234");
  await expectNoHorizontalOverflow(page);
});

test("Workflow control center — plan, tasks, timeline and gates", async ({ page }) => {
  await boot(page);
  const composer = page.locator(".composer textarea");
  await composer.fill("[mock-workflow] show structured workflow");
  await composer.press("Enter");
  const dock = page.getByRole("region", { name: "Workflow control center" });
  await expect(dock).toBeVisible();
  const backgroundIndicator = page.getByRole("button", { name: "Фоновые задачи: 1" });
  await expect(backgroundIndicator).toBeVisible();
  await backgroundIndicator.click();
  const backgroundPopover = page.getByRole("dialog", { name: "Активные фоновые задачи" });
  await expect(backgroundPopover.getByText("Review rewind transaction", { exact: true })).toBeVisible();
  await expect(backgroundPopover.getByText("Protected · live", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("background-tasks-topbar.png", { fullPage: true });
  await backgroundIndicator.click();

  // The indicator is global: browsing another workspace must not hide or
  // interrupt a long-running task. Task center navigates back to its owner.
  await page.locator(".proj-head", { hasText: "website" }).click();
  await expect(backgroundIndicator).toBeVisible();
  await backgroundIndicator.click();
  await expect(backgroundPopover.getByText("pi-app · reviewer · running", { exact: false })).toBeVisible();
  await backgroundPopover.getByRole("button", { name: "Task center" }).click();
  await expect(page.locator(".topbar .title")).toHaveText("pi-app");
  await expect(dock.getByText("Review rewind transaction", { exact: true })).toBeVisible();
  await dock.getByRole("button", { name: /Workflow/ }).click();
  await expect(dock.getByText("Build", { exact: true })).toBeVisible();
  await expect(dock.getByText("npm test", { exact: false })).toBeVisible();
  await expect(dock.getByText("executor · attempt 1/5", { exact: false })).toBeVisible();
  await dock.getByRole("button", { name: /Plan/ }).click();
  await expect(dock.getByText("Execution backlog", { exact: true })).toBeVisible();
  await expect(dock.getByText("implementing workflow controls", { exact: false })).toBeVisible();
  await expect(page).toHaveScreenshot("workflow-plan-control-center.png", { fullPage: true });
  await dock.getByRole("button", { name: /Context/ }).click();
  await expect(dock.getByText("Live context", { exact: true })).toBeVisible();
  await expect(dock.getByText("Checkpoint", { exact: false }).first()).toBeVisible();
  await expect(dock.getByText("Compaction", { exact: false }).first()).toBeVisible();
  // Context and task snapshots intentionally exercise the permission gate.
  // Wait here so earlier snapshots retain their expected stream position.
  const blockPermission = page.getByRole("button", { name: "Заблокировать" });
  await expect(blockPermission).toBeVisible();
  await expect(page).toHaveScreenshot("workflow-context-control-center.png", { fullPage: true });
  await dock.getByRole("button", { name: /Tasks/ }).click();
  await expect(dock.getByText("Review rewind transaction", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("workflow-control-center.png", { fullPage: true });

  const tabs = dock.locator(".workflow-tabs button");
  const widthsBefore = await tabs.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
  await dock.getByRole("button", { name: "Transcript" }).click();
  await expect(dock.locator(".task-transcript")).toBeVisible();
  const widthsAfter = await tabs.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
  expect(widthsAfter).toEqual(widthsBefore);
  await expectNoHorizontalOverflow(page);

  await blockPermission.click();
  await expect(page.locator(".composer textarea")).toHaveAttribute("placeholder", "Workflow продолжает работу · Esc — остановить");
  await expect(page.getByTitle("Остановить активный workflow и фоновые задачи (Esc)")).toBeVisible();
});

test("Workflow repair prompt is a compact system card instead of a user bubble", async ({ page }) => {
  await boot(page);
  const composer = page.locator(".composer textarea");
  await composer.fill("[mock-workflow-retry] show retry card");
  await composer.press("Enter");

  const card = page.locator(".workflow-continuation");
  await expect(card).toBeVisible();
  await expect(card.getByText("Workflow продолжает работу", { exact: true })).toBeVisible();
  await expect(card.getByText("Independent evaluation запросила исправления", { exact: true })).toBeVisible();
  await expect(card.locator(".workflow-continuation-body")).toBeHidden();
  await card.locator("summary").click();
  await expect(card.locator(".workflow-continuation-body")).toBeVisible();
  await expect(card).toContainText("machine-checkable clause protocol");
  await expectNoHorizontalOverflow(page);
});

test("Same-session rewind restores text and image, then resends without creating a session", async ({ page }) => {
  await boot(page);
  const rowsBefore = await page.locator(".sess-row").count();
  await page.locator(".sess-row", { hasText: "Rewind transaction" }).click();
  const target = page.getByText("Второй запрос с изображением", { exact: true });
  await expect(target).toBeVisible();
  await target.hover();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Они будут потеряны. Продолжить?");
    void dialog.dismiss();
  });
  await page.getByTitle("Изменить и повторить отсюда — в этой же сессии").last().click();
  await expect(target).toBeVisible();
  await expect(page.locator(".composer textarea")).toHaveValue("");

  await target.hover();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Session diff:");
    expect(dialog.message()).toContain("вложения (1)");
    expect(dialog.message()).toContain("Они будут потеряны. Продолжить?");
    void dialog.accept();
  });
  await page.getByTitle("Изменить и повторить отсюда — в этой же сессии").last().click();

  const composer = page.locator(".composer textarea");
  await expect(composer).toHaveValue("Второй запрос с изображением");
  await expect(page.getByTitle("Открыть attachment-1.png")).toBeVisible();
  await expect(page.getByText("Второй ответ будет оставлен в abandoned branch.", { exact: true })).toHaveCount(0);
  expect(await page.locator(".sess-row").count()).toBe(rowsBefore);

  await composer.fill("Изменённый второй запрос");
  await composer.press("Enter");
  await expect(page.getByText("Изменённый второй запрос", { exact: true })).toBeVisible();
  expect(await page.locator(".sess-row").count()).toBe(rowsBefore);
  await page.getByRole("button", { name: "Заблокировать" }).click();
});

test("Image attachment is a square preview in composer and the sent chat message", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("button", { name: "Прикрепить файлы или изображения" })).toBeEnabled();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nUwAAAAASUVORK5CYII=",
    "base64",
  );
  await page.locator(".composer input[type=file]").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: png,
  });

  const composerTile = page.locator(".composer .image-attachment-preview");
  await expect(composerTile).toBeVisible();
  const box = await composerTile.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs((box?.width ?? 0) - (box?.height ?? 1))).toBeLessThanOrEqual(1);

  const send = page.getByTitle(/^Отправить/);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(composerTile).toHaveCount(0);

  const sent = page.locator(".msg.user").last();
  const sentPreview = sent.getByRole("button", { name: "Открыть preview изображения reference.png" });
  await expect(sentPreview).toBeVisible();
  await sentPreview.click();
  const dialog = page.getByRole("dialog", { name: "Preview изображения reference.png" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("reference.png");
  await expect(dialog).toContainText("image/png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(sentPreview).toBeFocused();

  const deny = page.getByRole("button", { name: "Заблокировать" });
  if (await deny.isVisible({ timeout: 3_000 }).catch(() => false)) await deny.click();
});

test("Image draft survives screen switches but stays isolated by session", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Открыть сессию «Fix supervisor race»" }).click();
  await expect(page.getByRole("button", { name: "Прикрепить файлы или изображения" })).toBeEnabled();
  const input = page.locator(".composer input[type=file]");
  await input.setInputFiles({
    name: "session-draft.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nUwAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.locator(".composer .image-attachment-preview")).toHaveCount(1);

  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByRole("button", { name: "Чат" }).click();
  await expect(page.locator(".composer img[alt='session-draft.png']")).toBeVisible();

  await page.getByRole("button", { name: "Открыть сессию «Rewind transaction»" }).click();
  await expect(page.locator(".composer .image-attachment-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Открыть сессию «Fix supervisor race»" }).click();
  await expect(page.locator(".composer img[alt='session-draft.png']")).toBeVisible();
});

test("Persisted Pi image blocks render in history instead of disappearing", async ({ page }) => {
  await boot(page);
  await page.locator(".sess-row", { hasText: "Rewind transaction" }).click();
  const message = page.locator(".msg.user").filter({ hasText: "Второй запрос с изображением" });
  await expect(message).toBeVisible();
  await expect(message.getByRole("button", { name: "Открыть preview изображения attachment-1.png" })).toBeVisible();
  await expect(message.locator("img[alt='attachment-1.png']")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(message.locator(".bubble")).toHaveScreenshot("persisted-image-message.png");
});

test("Pi image privacy policy is editable and enforced by the composer", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByRole("button", { name: /^Основные/ }).click();
  const blockImages = page.getByRole("switch", { name: "Не отправлять изображения провайдерам" });
  await expect(blockImages).toHaveAttribute("aria-checked", "false");
  await blockImages.click();
  await expect(blockImages).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Чат" }).click();
  await expect(page.getByRole("button", { name: "Прикрепить файлы или изображения" })).toHaveAttribute(
    "title",
    /Изображения заблокированы/,
  );
  await page.locator(".composer input[type=file]").setInputFiles({
    name: "private.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
  });
  await expect(page.locator(".composer .image-attachment-preview")).toHaveCount(0);
  await expect(page.getByText("Изображения отключены в Settings → Основные → Изображения", { exact: true })).toBeVisible();
});

test("Live turn shows the process, then folds it into Worked for (Codex flow)", async ({ page }) => {
  await boot(page);
  const composer = page.locator(".composer textarea");
  await composer.fill("Покажи процесс");
  await composer.press("Enter");

  // Пока токены ещё приходят: thinking по умолчанию свёрнут, но его можно
  // независимо раскрыть и снова закрыть; выбор переживает следующий delta.
  const thinkingToggle = page.locator(".thinking .t-head").first();
  await expect(thinkingToggle).toBeVisible();
  await expect(thinkingToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".thinking .t-body")).toHaveCount(0);
  await thinkingToggle.click();
  await expect(thinkingToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".thinking .t-body").first()).toBeVisible();
  await page.waitForTimeout(250);
  await expect(thinkingToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".thinking .t-body").first()).toBeVisible();
  await thinkingToggle.click();
  await expect(thinkingToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".thinking .t-body")).toHaveCount(0);

  const block = page.getByRole("button", { name: "Заблокировать" });
  await expect(block).toBeVisible();
  await expect(page.locator(".toolcard").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Worked for/ })).toHaveCount(0);
  // во время хода личность модели несёт только индикатор — статичной шапки нет
  await expect(page.locator(".processing")).toBeVisible();
  await expect(page.locator(".msg-model")).toHaveCount(0);

  await block.click();

  // ход завершён: процесс свернулся, ответ отдельно, индикатор исчез
  const worked = page.getByRole("button", { name: /Worked for/ });
  await expect(worked).toBeVisible();
  await expect(page.locator(".processing")).toHaveCount(0);
  await expect(page.locator(".msg-model")).toHaveCount(1);
  await expect(page.locator(".run-summary .thinking")).toHaveCount(0);
  await worked.click();
  await expect(page.locator(".run-summary .thinking")).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
});

test("Streaming stays pinned at bottom until the user deliberately scrolls up", async ({ page }) => {
  await boot(page);
  await page.locator(".sess-row", { hasText: "Старый рефакторинг" }).click();
  const scroller = page.locator(".msg-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  const composer = page.locator(".composer textarea");
  await composer.fill("Покажи процесс");
  await composer.press("Enter");
  await expect(page.locator(".processing")).toBeVisible();

  // Existing live row grows on every token; follow mode must keep the viewport
  // magnetized rather than only reacting when a new array item is appended.
  await expect.poll(() => scroller.evaluate((element) =>
    Math.round(element.scrollHeight - element.clientHeight - element.scrollTop)
  )).toBeLessThanOrEqual(2);

  await scroller.hover();
  await page.mouse.wheel(0, -700);
  await page.waitForTimeout(80);
  const detachedTop = await scroller.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(500);
  const detached = await scroller.evaluate((element) => ({
    top: element.scrollTop,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop,
  }));
  expect(Math.abs(detached.top - detachedTop)).toBeLessThan(8);
  expect(detached.gap).toBeGreaterThan(40);

  // Restore/finish the mocked run so the test does not leave a pending dialog.
  await page.getByRole("button", { name: "Заблокировать" }).click();
});

test("Turn timing notice uses the compact status card", async ({ page }) => {
  await boot(page);
  await page.locator(".sess-row", { hasText: "Добавь тесты" }).click();
  // «✻ Turn took…» — хвост финального ответа: строка вырезана из текста и
  // показана компактным виджетом-строкой
  const timing = page.locator(".turn-timing-card");
  await expect(timing).toBeVisible();
  await expect(timing).toContainText("12s");
  await expect(timing).toContainText("47s");
  await expect(timing).toContainText("2 хода");
  await expect(page.getByText(/✻ Turn took/)).toHaveCount(0);
  // сводка «Worked for» восстановлена из файла сессии (переживает рестарты)
  await expect(page.getByRole("button", { name: /Worked for 12s/ })).toBeVisible();
});

test("Model avatar — separate idle and LLM-working states", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".topbar .agent-avatar")).toHaveCount(0);
  await page.locator(".composer textarea").fill("Проверка аватара модели");
  await page.locator(".composer textarea").press("Enter");
  await page.getByRole("button", { name: "Заблокировать" }).click();
  await expect(page.getByTitle(/^Отправить/)).toBeVisible();
  await page.getByTitle("ollama/qwen-local", { exact: true }).click();
  await page.getByTitle("Задать отображаемое название").first().click();
  await page.locator(".model-alias-editor").getByRole("button", { name: "Настроить аватар модели" }).click();
  const chooseFile = page.getByRole("button", { name: "Выбрать изображение…" });
  await expect(chooseFile).toBeVisible();
  const fileBox = await chooseFile.boundingBox();
  expect(fileBox).not.toBeNull();
  expect(fileBox!.y + fileBox!.height).toBeLessThanOrEqual(720);
  await page.getByRole("button", { name: "Spark" }).click();
  await page.getByRole("button", { name: "LLM работает" }).click();
  await page.getByRole("button", { name: "Reasoning" }).click();
  await expect(page.getByRole("button", { name: "Reasoning" })).toHaveClass(/active/);
  await expect(page.getByText(/Отдельный образ для покоя и генерации .* Lottie\/GIF\/WebP\/PNG/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("agent-avatar-dual-state.png", { fullPage: true });

  // Во время следующего хода заданный working-avatar заменяет стандартные точки,
  // а статус использует UI-псевдоним модели, не внутреннее имя pi.
  await page.locator(".composer textarea").click();
  await page.locator(".composer textarea").fill("Проверка рабочего статуса");
  await page.locator(".composer textarea").press("Enter");
  const processing = page.locator(".processing");
  await expect(processing.locator(".agent-avatar.working")).toBeVisible();
  const composerModel = page.locator(".composer").getByTitle("ollama/qwen-local", { exact: true });
  await expect(composerModel.locator(".agent-avatar")).toBeVisible();
  await expect(composerModel.locator(".agent-avatar.working")).toHaveCount(0);
  await expect(processing.locator(".pdots")).toHaveCount(0);
  await expect(processing.locator(".p-label")).toContainText("ThinkingCap 27B");
  await expect(processing.locator(".p-label")).toContainText(/(размышляет|анализирует запрос|изучает контекст|осматривается|планирует шаги|проверяет детали|исследует варианты|сопоставляет данные|формулирует ответ)/);
  await expect(processing.locator(".p-label")).not.toContainText("pi работает");
});

/** Поповер должен целиком помещаться во вьюпорт и быть кликабельным (не под UI). */
async function expectPopoverUsable(page: Page) {
  const state = await page.evaluate(() => {
    const pop = document.querySelector<HTMLElement>(".avatar-popover");
    if (!pop) return { open: false } as const;
    const b = pop.getBoundingClientRect();
    const hint = pop.querySelector<HTMLElement>(".hint")!;
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 20);
    return {
      open: true,
      portaled: pop.parentElement === document.body,
      fitsHorizontally: b.left >= 0 && b.right <= window.innerWidth,
      fitsVertically: b.top >= 0 && b.bottom <= window.innerHeight,
      onTop: pop.contains(hit),
      hintClipped: hint.scrollWidth > hint.clientWidth + 1,
      box: { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    } as const;
  });
  expect(state.open, "avatar popover is open").toBe(true);
  expect(state, JSON.stringify(state, null, 2)).toMatchObject({
    portaled: true,
    fitsHorizontally: true,
    fitsVertically: true,
    onTop: true,
    hintClipped: false,
  });
}

test("Model avatar popover escapes clipping containers (settings + model dropdown)", async ({ page }) => {
  await boot(page);

  // 1) Настройки: .settings-group имеет overflow:hidden и обрезал поповер,
  //    а сам поповер вылезал за правый край окна
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByRole("button", { name: /^Основные/ }).click();
  const settingsRow = page.locator(".form-row").filter({ hasText: "Иконка модели" });
  await expect(settingsRow).toBeVisible();
  await settingsRow.getByRole("button", { name: "Настроить аватар модели" }).click();
  await expectPopoverUsable(page);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 400);

  // 2) Выпадашка моделей: у .dropdown анимация оставляет transform, из-за чего
  //    он становился containing block для position:fixed — поповер уезжал за экран
  await page.getByRole("button", { name: "Чат" }).click();
  await page.locator(".c-row").getByRole("button", { name: /ThinkingCap 27B|модель/ }).click();
  const aliasButtons = page.getByTitle("Задать отображаемое название");
  await expect(aliasButtons.first()).toBeVisible();
  await aliasButtons.last().click(); // последняя модель — худший случай по вертикали
  await page.locator(".model-alias-editor").getByRole("button", { name: "Настроить аватар модели" }).click();
  await expectPopoverUsable(page);
});

test("Model picker is usable before the agent starts (multi-provider catalog)", async ({ page }) => {
  await boot(page);
  // на чистом заходе агент не запущен
  await expect(page.locator(".statusline")).toContainText("агент запустится с первым сообщением");

  // модель и thinking берутся из конфигов pi, а не из живого агента
  const modelChip = page.locator(".c-row").getByRole("button", { name: /ThinkingCap 27B/ });
  await expect(modelChip).toBeVisible();
  const thinking = page.locator(".c-row").getByRole("button", { name: /thinking:/ });
  await expect(thinking).toBeEnabled();

  // каталог из models.json: несколько провайдеров и моделей ещё до спавна
  await modelChip.click();
  const options = page.locator(".dropdown .dd-item");
  await expect(options).toHaveCount(4);
  await expect(options.filter({ hasText: "anthropic/claude-opus-4-8" })).toBeVisible();
  await expect(options.filter({ hasText: "ollama/qwen-coder-30b" })).toBeVisible();
  await expect(page.getByText("Агент не запущен")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("Sidebar: project rows always show a state dot right of the session count", async ({ page }) => {
  await boot(page);
  // до запуска агента слот занят серым кружком — иначе цифра читается как сбитая
  const idle = page.locator(".proj-head .project-state.dot.idle");
  await expect(idle.first()).toBeVisible();
  await expect(idle).toHaveCount(2);
  const layout = await page.evaluate(() => {
    const head = document.querySelector(".proj-head")!;
    const count = head.querySelector(".ws-count")!.getBoundingClientRect();
    const dot = head.querySelector(".project-state")!.getBoundingClientRect();
    return { dotRightOfCount: Math.round(dot.left) >= Math.round(count.right), countRight: Math.round(count.right) };
  });
  expect(layout.dotRightOfCount).toBe(true);

  // агент оживает: кружок становится зелёным, но счётчик остаётся на месте
  const composer = page.locator(".composer textarea");
  await composer.fill("go");
  await composer.press("Enter");
  await expect(page.locator(".proj-head .project-state").first()).not.toHaveClass(/idle/);
  const after = await page.evaluate(() => Math.round(document.querySelector(".proj-head .ws-count")!.getBoundingClientRect().right));
  expect(after).toBe(layout.countRight);
});

test("Chat column and composer share the same width", async ({ page }) => {
  await boot(page);
  await page.locator(".sess-row", { hasText: "Fix supervisor race" }).click();
  await expect(page.getByRole("button", { name: /Worked for/ })).toBeVisible();
  await expect(page.locator(".gitbar")).toBeVisible();
  const widths = await page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right) };
    };
    const vm = document.querySelector(".virtual-message");
    return {
      message: box(vm?.firstElementChild ?? null),
      composer: box(document.querySelector(".composer")),
      gitbar: box(document.querySelector(".gitbar")),
    };
  });
  expect(widths.composer).toEqual(widths.message);
  expect(widths.gitbar).toEqual(widths.message);
});

test("Expanded Worked for survives virtual scrolling and does not jitter the feed", async ({ page }) => {
  await boot(page);
  await page.locator(".sess-row", { hasText: "Fix supervisor race" }).click();

  const worked = page.getByRole("button", { name: /Worked for/ }).first();
  await expect(worked).toBeVisible();
  await worked.click();
  await expect(page.locator(".run-summary.open")).toHaveCount(1);

  // короткий вьюпорт заставляет Virtuoso реально размонтировать элементы
  await page.setViewportSize({ width: 1100, height: 400 });
  await page.waitForTimeout(300);

  const result = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>(".msg-scroll")!;
    const summary = document.querySelector<HTMLElement>(".run-summary.open")!;
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 900));
    const destroyedOffscreen = !document.contains(summary);

    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 900));
    // лента должна успокоиться сама, без ввода
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(Math.round(scroller.scrollTop));
      await new Promise((r) => setTimeout(r, 70));
    }
    return {
      destroyedOffscreen,
      stillOpen: document.querySelectorAll(".run-summary.open").length,
      jitterPx: Math.max(...samples) - Math.min(...samples),
    };
  });

  // раскрытие переживает размонтирование — иначе высота элемента скачет
  // относительно кэша Virtuoso и ленту начинает дёргать
  expect(result.stillOpen).toBeGreaterThanOrEqual(1);
  expect(result.jitterPx).toBe(0);
});

test("Application hotkeys — workspaces and roadmap navigation", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".ws.active")).toContainText("website");
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".ws.active")).toContainText("pi-app");
  await page.keyboard.press("Meta+r");
  await expect(page.getByRole("button", { name: /Изменения/ })).toBeVisible();
  await page.keyboard.press("Meta+e");
  await expect(page.locator(".preview-col")).toBeVisible();
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByRole("heading", { name: "Основные" })).toBeVisible();
  await page.keyboard.press("Meta+Slash");
  await expect(page.getByText("Переключить workspace по номеру", { exact: true })).toBeVisible();
});

test("Live preview — shared native server exposes readiness, logs and responsive frame", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+e");
  const preview = page.locator(".preview-pane");
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: /Запустить/ }).click();
  await expect(preview.locator(".pv-runtime.ready")).toHaveText("ready");
  await expect(preview.locator("iframe[title=preview]")).toHaveAttribute("src", "http://localhost:1420");
  await expect(preview.locator(".pv-logs")).toContainText("VITE ready");
  await expectNoHorizontalOverflow(page);
  await preview.getByRole("button", { name: /Стоп/ }).click();
  await expect(preview.locator(".pv-runtime")).toHaveCount(0);
});

test("Live preview does not attach a late server response to another workspace", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+e");
  const preview = page.locator(".preview-pane");
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: /Запустить/ }).click();
  await page.getByRole("button", { name: "Выбрать проект «website»" }).click();
  await expect(page.locator(".ws.active")).toContainText("website");
  await page.waitForTimeout(300);
  await expect(preview.locator(".pv-runtime")).toHaveCount(0);
  await expect(preview.getByRole("button", { name: /Запустить/ })).toBeEnabled();
});

test("Live preview — harness event opens the split and exposes agent inspection evidence", async ({ page }) => {
  await boot(page);
  const composer = page.locator(".composer textarea");
  await composer.fill("[mock-preview] inspect the rendered UI");
  await composer.press("Enter");
  const preview = page.locator(".preview-pane");
  await expect(preview).toBeVisible();
  await expect(preview.locator(".pv-runtime.ready")).toHaveText("ready");
  await expect(preview.locator(".pv-runtime.inspected")).toHaveText("agent checked");
  await expect(page.locator(".topbar").getByRole("button", { name: /Превью · ready/ })).toBeVisible();
  await expect(preview.locator("iframe[title=preview]")).toHaveAttribute("src", "http://localhost:1420");

  await preview.getByRole("button", { name: /Стоп/ }).click();
  await expect(preview.locator(".pv-runtime.stopped")).toHaveText("stopped");
  await expect(preview.locator("iframe[title=preview]")).toHaveCount(0);
  await expect(page.locator(".topbar").getByRole("button", { name: /Превью · stopped/ })).toBeVisible();
});
