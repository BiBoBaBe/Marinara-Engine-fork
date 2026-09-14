import { test, expect, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("Roleplay scene controls keep readable Chroma surfaces over chat text", async ({ page, request }, testInfo) => {
  const chatIds: string[] = [];
  try {
    const origin = await (
      await request.post("/api/chats", {
        data: { name: "Scene controls origin", mode: "conversation", characterIds: [] },
      })
    ).json();
    chatIds.push(origin.id);
    const scene = await (
      await request.post("/api/chats", { data: { name: "Scene controls fixture", mode: "roleplay", characterIds: [] } })
    ).json();
    chatIds.push(scene.id);
    expect(
      (
        await request.patch(`/api/chats/${scene.id}/metadata`, {
          data: { sceneStatus: "active", sceneOriginChatId: origin.id },
        })
      ).ok(),
    ).toBeTruthy();
    await request.post(`/api/chats/${scene.id}/messages`, {
      data: {
        role: "assistant",
        content: Array(12)
          .fill(
            "The city lights shimmer beyond the laboratory windows. Notes and instruments cover the table as the conversation continues.",
          )
          .join("\n\n"),
      },
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["roleplay"],
      appAccentPulseMode: false,
      theme: "dark",
      appAccentColor: "#14b8a6",
      chatChromeTextColor: "#99f6e4",
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: scene.id, version },
    );
    await page.goto("/");
    const back = page.getByRole("button", { name: "Back to conversation", exact: true });
    const bar = back.locator("..");
    const discard = bar.getByRole("button", { name: "Discard", exact: true });
    const convert = bar.getByRole("button", { name: "Convert", exact: true });
    for (const theme of ["dark", "light"] as const) {
      const color = theme === "dark" ? "#99f6e4" : "#115e59";
      await page.evaluate(
        async ({ theme, color }) => {
          const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
          useUIStore.getState().setTheme(theme);
          useUIStore.getState().setChatChromeTextColor(color);
        },
        { theme, color },
      );
      await expect(back).toBeVisible();
      await expect(discard).toBeVisible();
      await expect(convert).toBeVisible();
      // Wait for the existing theme transition before comparing the settled Chroma colors.
      for (const button of [back, bar.getByRole("button", { name: "End Scene", exact: true }), discard, convert]) {
        await expect(button).toHaveCSS("color", theme === "dark" ? "rgb(153, 246, 228)" : "rgb(17, 94, 89)");
      }
      await page.screenshot({ path: testInfo.outputPath(`scene-controls-${theme}.png`) });
      const appearance = await bar.locator("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return {
            background: style.backgroundColor,
            border: style.border,
            left: rect.left,
            right: rect.right,
          };
        }),
      );
      expect(appearance).toHaveLength(4);
      for (const button of appearance) {
        expect(button.background).toBe(appearance[0]!.background);
        expect(button.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(button.border).toBe(appearance[0]!.border);
        expect(button.left).toBeGreaterThanOrEqual(0);
        expect(button.right).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
      await discard.click();
      await expect(bar.getByText("Discard scene?", { exact: true })).toBeVisible();
      await bar.getByRole("button", { name: "No", exact: true }).click();
      await expect(discard).toBeVisible();
      await convert.click();
      const confirmation = page.getByRole("dialog", {
        name: "Convert this scene into a standalone roleplay?",
        exact: true,
      });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  } finally {
    await page.close();
    for (const id of chatIds.reverse()) await request.delete(`/api/chats/${id}?force=true`).catch(() => undefined);
  }
});

test("Roleplay line volume stays on screen and touch reveal preserves action colors", async ({
  page,
  request,
}, testInfo) => {
  let characterId = "";
  let chatId = "";
  try {
    const character = await (
      await request.post("/api/characters", { data: { data: { name: "Volume fixture" } } })
    ).json();
    characterId = character.id;
    const chat = await (
      await request.post("/api/chats", {
        data: { name: "Roleplay volume controls", mode: "roleplay", characterIds: [character.id] },
      })
    ).json();
    chatId = chat.id;
    const message = await (
      await request.post(`/api/chats/${chat.id}/messages`, {
        data: { role: "assistant", characterId: character.id, content: "The volume control should stay within reach." },
      })
    ).json();
    const config = await (await request.get("/api/tts/config")).json();
    await page.route("**/api/tts/config", (route) => route.fulfill({ json: { ...config, enabled: true } }));
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["roleplay"],
      appAccentPulseMode: false,
      theme: "dark",
      chatChromeTextColor: "#14b8a6",
      ttsLineVolume: 75,
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chat.id, version },
    );
    await page.goto("/");
    const row = page.locator(`[data-message-id="${message.id}"]`);
    const copy = row.getByRole("button", { name: "Copy", exact: true });
    const volume = row.getByRole("button", { name: /^Line volume: \d+%$/u });
    const actions = row.locator(".mari-message-actions");
    const actionAppearance = () =>
      actions.locator("button").evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            label: element.getAttribute("aria-label"),
            color: style.color,
            background: style.backgroundColor,
            shadow: style.boxShadow,
          };
        }),
      );
    await row.scrollIntoViewIfNeeded();
    await expect(volume).toBeAttached();
    const beforeReveal = await actionAppearance();
    if (testInfo.project.use.hasTouch) await row.getByText("The volume control should stay within reach.").tap();
    else await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect.poll(actionAppearance).toEqual(beforeReveal);
    await expect(copy).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
    await expect(row).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");

    for (const direction of ["ltr", "rtl"] as const) {
      await page.evaluate(
        async (theme) => {
          const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
          useUIStore.getState().setTheme(theme);
        },
        direction === "ltr" ? "dark" : "light",
      );
      await row.evaluate((element, direction) => {
        element.setAttribute("dir", direction);
      }, direction);
      if (testInfo.project.use.hasTouch) await volume.tap();
      else await volume.click();
      const panel = page.getByRole("dialog", { name: "Line volume", exact: true });
      await expect(panel).toBeVisible();
      const bounds = await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: innerWidth,
          height: innerHeight,
        };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.width);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
      const slider = panel.getByRole("slider", { name: "Line volume", exact: true });
      await expect(slider).toBeFocused();
      await slider.press("Home");
      await slider.press("ArrowRight");
      await expect(slider).toHaveValue("1");
      await expect(volume).toHaveAttribute("aria-label", "Line volume: 1%");
      await page.screenshot({ path: testInfo.outputPath(`line-volume-${direction}.png`) });
      await slider.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(volume).toBeFocused();
      await expect(actions).toHaveCSS("opacity", "1");
      await expect(copy).toHaveCSS("color", beforeReveal.find((button) => button.label === "Copy")!.color);
    }
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
    if (characterId) await request.delete(`/api/characters/${characterId}`).catch(() => undefined);
  }
});

test("Game translation follows changed narration and remains manually accessible", async ({ page, request }) => {
  page.setDefaultTimeout(10_000);
  const chat = await (
    await request.post("/api/chats", { data: { name: "Translation sweep", mode: "game", characterIds: [] } })
  ).json();
  const chatIds: string[] = [chat.id];
  try {
    expect(
      (
        await request.patch(`/api/chats/${chat.id}/metadata`, {
          data: {
            gameId: chat.id,
            gameSessionStatus: "active",
            gameIntroPresented: true,
            gameImageAutoGenerationEnabled: false,
            translationOutputTargetLang: "pl",
          },
        })
      ).ok(),
    ).toBeTruthy();
    const message = await (
      await request.post(`/api/chats/${chat.id}/messages`, {
        data: { role: "assistant", content: "The bridge is safe." },
      })
    ).json();
    const requested: string[] = [];
    await page.route("**/api/translate", async (route) => {
      const body = route.request().postDataJSON();
      expect(body.targetLanguage).toBe("pl");
      requested.push(body.text);
      await route.fulfill({
        json: {
          translatedText: body.text.includes("Note:")
            ? "[Note: Zapisana wiadomość.]"
            : body.text.includes("river")
              ? "Rzeka jest głęboka."
              : "Most jest bezpieczny.",
        },
      });
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chibiProfessorMariEnabled: false,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      gameInstantTextReveal: true,
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chat.id, version },
    );
    await page.goto("/");
    const panel = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(panel).toContainText("The bridge is safe.");
    await panel.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(panel).toContainText("Most jest bezpieczny.");
    const extra = async () => {
      const messages = await (await request.get(`/api/chats/${chat.id}/messages`)).json();
      const row = messages.find((entry: { id: string }) => entry.id === message.id);
      return typeof row.extra === "string" ? JSON.parse(row.extra) : row.extra;
    };
    await expect.poll(async () => (await extra()).translationSource).toBe("The bridge is safe.");
    expect(
      (
        await request.patch(`/api/chats/${chat.id}/messages/${message.id}`, { data: { content: "The river is deep." } })
      ).ok(),
    ).toBeTruthy();
    expect(
      (await request.patch(`/api/chats/${chat.id}/metadata`, { data: { autoTranslate: true } })).ok(),
    ).toBeTruthy();
    await page.reload();
    await expect(panel).toContainText("The river is deep.");
    await expect(panel).toContainText("Rzeka jest głęboka.");
    await expect(panel).not.toContainText("Most jest bezpieczny.");
    await expect.poll(async () => (await extra()).translationSource).toBe("The river is deep.");
    expect(requested).toEqual(["The bridge is safe.", "The river is deep."]);
    await panel.getByRole("button", { name: "Hide translation", exact: true }).click();
    await expect(panel).not.toContainText("Rzeka jest głęboka.");
    await expect.poll(async () => (await extra()).translationHidden).toBe(true);
    await page.reload();
    await expect(panel).toContainText("The river is deep.");
    await expect(panel).not.toContainText("Rzeka jest głęboka.");
    await panel.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(panel).toContainText("Rzeka jest głęboka.");
    expect(requested).toEqual(["The bridge is safe.", "The river is deep.", "The river is deep."]);

    const otherChat = await (
      await request.post("/api/chats", { data: { name: "Other translation chat", mode: "game", characterIds: [] } })
    ).json();
    chatIds.push(otherChat.id);
    await request.patch(`/api/chats/${otherChat.id}/metadata`, {
      data: {
        gameId: otherChat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
      },
    });
    await request.post(`/api/chats/${otherChat.id}/messages`, {
      data: { role: "assistant", content: "A different story." },
    });
    let releasePersistedTranslation: (() => Promise<void>) | undefined;
    await page.route(`**/api/chats/${chat.id}/messages/${message.id}/extra`, async (route) => {
      if (route.request().postDataJSON().translation !== "Opóźnione tłumaczenie.") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      // The server has saved the result, but the inactive chat's query cache is still stale.
      releasePersistedTranslation = () => route.fulfill({ response });
    });
    let pendingTranslation: Route | undefined;
    await page.route(
      "**/api/translate",
      (route) => {
        pendingTranslation = route;
      },
      { times: 1 },
    );
    await panel.getByRole("button", { name: "Hide translation", exact: true }).click();
    await panel.getByRole("button", { name: "Translate", exact: true }).click();
    await expect.poll(() => Boolean(pendingTranslation)).toBe(true);
    const switchChat = async (id: string) => {
      await page.evaluate(async (id) => {
        const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
        useChatStore.getState().setActiveChatId(id);
      }, id);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const { useTranslationStore } = await import("/src/stores/translation.store.ts" as string);
            return useTranslationStore.getState().config.chatId;
          }),
        )
        .toBe(id);
    };
    await switchChat(otherChat.id);
    await expect(panel).toContainText("A different story.");
    await pendingTranslation!.fulfill({ json: { translatedText: "Opóźnione tłumaczenie." } });
    await expect.poll(() => Boolean(releasePersistedTranslation)).toBe(true);
    await expect.poll(async () => (await extra()).translation).toBe("Opóźnione tłumaczenie.");
    expect(
      await page.evaluate(async (id) => {
        const { useTranslationStore } = await import("/src/stores/translation.store.ts" as string);
        const state = useTranslationStore.getState();
        return {
          translation: state.translations[id],
          source: state.translationSources[id],
          translating: state.translating[id],
        };
      }, message.id),
    ).toEqual({ translation: undefined, source: undefined, translating: undefined });
    await switchChat(chat.id);
    await expect(panel).toContainText("The river is deep.");
    await releasePersistedTranslation!();
    await expect(panel).toContainText("Opóźnione tłumaczenie.");
    await request.patch(`/api/chats/${chat.id}/metadata`, { data: { autoTranslate: false } });
    await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "[Note: A written message.]" },
    });
    await page.reload();
    await expect(panel).toContainText("You find a note...");
    await page.locator("div.fixed.inset-y-0").filter({ hasText: "A written message." }).getByRole("button").click();
    await panel.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(panel).toContainText("Zapisana wiadomość.");
  } finally {
    await Promise.all(chatIds.map((id) => request.delete(`/api/chats/${id}`)));
  }
});

test("Notification position is selectable, moves errors, and survives reload", async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(
    page,
    {
      hasCompletedOnboarding: true,
      chibiProfessorMariEnabled: false,
      sidebarOpen: false,
      rightPanelOpen: true,
      rightPanel: "settings",
      settingsTab: "general",
    },
    "if-missing",
  );
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), version);
  await page.goto("/");
  const selector = page.getByRole("combobox", { name: /Notification position/ });
  await page.getByPlaceholder("Search settings").fill("notification position");
  await page
    .locator(".mari-settings-search-header button")
    .filter({ hasText: "Notification position" })
    .first()
    .click();
  await expect(selector).toBeFocused();
  await expect(selector).toHaveValue("top");
  await selector.selectOption("bottom");
  const error = async () =>
    page.evaluate(async () => {
      const moduleUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => new URL(url).pathname.endsWith("/sonner.js"));
      if (!moduleUrl) throw new Error("The app's notification module was not loaded");
      const { toast } = await import(moduleUrl);
      toast.error("Notification position fixture", { duration: Infinity });
    });
  await error();
  await expect(page.locator('[data-sonner-toaster][data-y-position="bottom"]')).toContainText(
    "Notification position fixture",
  );
  await page.reload();
  await expect(selector).toHaveValue("bottom");
  await error();
  await expect(page.locator('[data-sonner-toaster][data-y-position="bottom"] [data-sonner-toast]')).toBeVisible();
  await selector.selectOption("top");
  await expect(page.locator('[data-sonner-toaster][data-y-position="top"] [data-sonner-toast]')).toBeVisible();
});
