import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function prepare(page: import("@playwright/test").Page, theme: "light" | "dark") {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(
    page,
    { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false, theme },
    "if-missing",
  );
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), version);
}

for (const theme of ["light", "dark"] as const) {
  test(`Scene preset variables save before entering the scene (${theme})`, async ({ page, request }, testInfo) => {
    const origin = await (
      await request.post("/api/chats", { data: { name: "Variable scene origin", mode: "conversation" } })
    ).json();
    const preset = await (await request.post("/api/prompts", { data: { name: "Variable scene preset" } })).json();
    const sceneIds: string[] = [];
    let releaseSave = () => {};
    try {
      expect(
        (
          await request.post(`/api/prompts/${preset.id}/variables`, {
            data: {
              variableName: "length",
              question: "How much detail?",
              options: [
                { id: "short", label: "Brief", value: "Write briefly." },
                { id: "long", label: "Detailed", value: "Write in detail." },
              ],
            },
          })
        ).ok(),
      ).toBeTruthy();
      expect(
        (
          await request.patch(`/api/prompts/${preset.id}`, {
            data: { defaultChoices: { length: "Write in detail." } },
          })
        ).ok(),
      ).toBeTruthy();
      await prepare(page, theme);
      await page.route("**/api/scene/plan", (route) =>
        route.fulfill({
          json: {
            plan: {
              name: "Scene: Variable laboratory",
              description: "A calm laboratory.",
              scenario: "A quiet experiment.",
              firstMessage: "The instruments hum softly.",
              background: null,
              characterIds: [],
              systemPrompt: "Continue the experiment.",
              rating: "sfw",
              relationshipHistory: "Colleagues.",
              participationGuide: "Explore freely.",
            },
          },
        }),
      );
      await page.goto("/");
      const start = () =>
        page.evaluate(async (chatId) => {
          const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
          const scene = (await import(
            "/src/lib/scene-generation.ts" as string
          )) as typeof import("../packages/client/src/lib/scene-generation");
          useChatStore.getState().setActiveChatId(chatId);
          void scene.startSceneWithPromptPreferences({ chatId, prompt: "A quiet experiment" });
        }, origin.id);
      const activeChatId = () =>
        page.evaluate(async () => {
          const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
          return useChatStore.getState().activeChatId;
        });
      const setup = page.getByRole("dialog", { name: "Scene Prompt Setup", exact: true });
      const choices = page.getByRole("dialog", { name: "Configure Preset Variables", exact: true });
      const create = async () => {
        const response = page.waitForResponse(
          (value) => value.url().endsWith("/api/scene/create") && value.request().method() === "POST",
        );
        await setup.getByRole("button", { name: "Plan Scene", exact: true }).click();
        const created = await response;
        expect(created.ok()).toBeTruthy();
        const id: string = (await created.json()).chatId;
        sceneIds.push(id);
        return id;
      };

      await start();
      await setup.getByRole("combobox", { name: "Prompt preset", exact: false }).selectOption(preset.id);
      // Cancel must not create a scene or replace the previously remembered preset.
      await setup.getByRole("button", { name: "Cancel", exact: true }).click();
      await start();
      await expect(setup.getByRole("combobox", { name: "Prompt preset", exact: false })).toHaveValue("");
      await setup.getByRole("combobox", { name: "Prompt preset", exact: false }).selectOption(preset.id);
      const firstId = await create();
      await expect(choices).toBeVisible();
      await expect(choices.getByRole("button", { name: /^Detailed/ })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(activeChatId).toBe(origin.id);
      await choices.getByRole("button", { name: /^Brief/ }).click();
      await page.screenshot({ path: testInfo.outputPath(`scene-preset-variables-${theme}.png`) });

      const pendingSave = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let saveAttempts = 0;
      await page.route(`**/api/chats/${firstId}/metadata`, async (route) => {
        if (++saveAttempts === 1) {
          await route.fulfill({ status: 503, json: { error: "Synthetic unavailable save" } });
          return;
        }
        await pendingSave;
        await route.continue();
      });
      const failedSave = page.waitForResponse(
        (value) => value.url().endsWith(`/api/chats/${firstId}/metadata`) && value.status() === 503,
      );
      await choices.getByRole("button", { name: "Confirm Choices", exact: true }).click();
      await failedSave;
      await expect(choices.getByRole("button", { name: "Confirm Choices", exact: true })).toBeEnabled();
      await expect(choices.getByRole("button", { name: /^Brief/ })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(activeChatId).toBe(origin.id);
      const saved = page.waitForResponse(
        (value) => value.url().endsWith(`/api/chats/${firstId}/metadata`) && value.request().method() === "PATCH",
      );
      await choices.getByRole("button", { name: "Confirm Choices", exact: true }).click();
      await expect(choices.getByRole("button", { name: /^Saving/ })).toBeDisabled();
      await expect(choices.getByRole("button", { name: "Skip", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(choices).toBeVisible();
      await expect.poll(activeChatId).toBe(origin.id);
      releaseSave();
      expect((await saved).ok()).toBeTruthy();
      await expect(choices).toBeHidden();
      await expect.poll(activeChatId).toBe(firstId);
      const first = await (await request.get(`/api/chats/${firstId}`)).json();
      const firstMeta = typeof first.metadata === "string" ? JSON.parse(first.metadata) : first.metadata;
      expect(firstMeta.presetChoices).toEqual({ length: "Write briefly." });

      await page.reload();
      await start();
      await expect(setup.getByRole("combobox", { name: "Prompt preset", exact: false })).toHaveValue(preset.id);
      const secondId = await create();
      await expect(choices).toBeVisible();
      // A scene-local choice must not overwrite the preset's saved defaults.
      await expect(choices.getByRole("button", { name: /^Detailed/ })).toHaveAttribute("aria-pressed", "true");
      await choices.getByRole("button", { name: "Skip", exact: true }).click();
      await expect.poll(activeChatId).toBe(secondId);
      const second = await (await request.get(`/api/chats/${secondId}`)).json();
      const secondMeta = typeof second.metadata === "string" ? JSON.parse(second.metadata) : second.metadata;
      expect(secondMeta.presetChoices).toBeUndefined();
    } finally {
      releaseSave();
      await page.close();
      for (const id of sceneIds) await request.delete(`/api/chats/${id}?force=true`);
      await request.delete(`/api/chats/${origin.id}?force=true`);
      await request.delete(`/api/prompts/${preset.id}`);
    }
  });
}

test("Scene setup remembers the selected preset and handles a deleted selection", async ({
  page,
  request,
}, testInfo) => {
  const origin = await (
    await request.post("/api/chats", { data: { name: "Scene origin", mode: "conversation", characterIds: [] } })
  ).json();
  const preset = await (await request.post("/api/prompts", { data: { name: "Quiet scene preset" } })).json();
  let sceneId: string | undefined;
  try {
    await prepare(page, "light");
    await page.route("**/api/scene/plan", (route) =>
      route.fulfill({
        json: {
          plan: {
            name: "Quiet laboratory",
            description: "A calm room",
            scenario: "A quiet moment",
            firstMessage: "The instruments hum softly.",
            background: null,
            characterIds: [],
            systemPrompt: "Keep the scene concise.",
            rating: "sfw",
            relationshipHistory: "Old colleagues.",
            participationGuide: "Continue the scene.",
          },
        },
      }),
    );
    await page.goto("/");
    await page.evaluate(async (chatId) => {
      const scene = (await import(
        "/src/lib/scene-generation.ts" as string
      )) as typeof import("../packages/client/src/lib/scene-generation");
      void scene.startSceneWithPromptPreferences({ chatId, prompt: "A quiet moment" });
    }, origin.id);
    const dialog = page.getByRole("dialog", { name: "Scene Prompt Setup", exact: true });
    const select = dialog.getByRole("combobox", { name: "Prompt preset", exact: false });
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("");
    await select.selectOption(preset.id);
    await page.screenshot({ path: testInfo.outputPath("scene-preset-light.png") });
    const created = page.waitForResponse(
      (response) => response.url().endsWith("/api/scene/create") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Plan Scene", exact: true }).click();
    const response = await created;
    expect(response.ok()).toBeTruthy();
    sceneId = (await response.json()).chatId;
    expect((await (await request.get(`/api/chats/${sceneId}`)).json()).promptPresetId).toBe(preset.id);
    await page.reload();
    const reopen = async () =>
      page.evaluate(async () => {
        const scene = (await import(
          "/src/lib/scene-generation.ts" as string
        )) as typeof import("../packages/client/src/lib/scene-generation");
        void scene.requestScenePromptPreferences();
      });
    await reopen();
    await expect(select).toHaveValue(preset.id);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await request.delete(`/api/prompts/${preset.id}`);
    await page.reload();
    await reopen();
    await expect(dialog.getByRole("alert")).toContainText("Choose another preset or None");
    await expect(dialog.getByRole("button", { name: "Plan Scene", exact: true })).toBeDisabled();
    await select.selectOption("");
    await expect(dialog.getByRole("button", { name: "Plan Scene", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Plan Scene", exact: true }).click();
    await reopen();
    await expect(select).toHaveValue("");
  } finally {
    await page.close();
    if (sceneId) await request.delete(`/api/chats/${sceneId}?force=true`);
    await request.delete(`/api/chats/${origin.id}?force=true`);
    await request.delete(`/api/prompts/${preset.id}`);
  }
});

test("Scene setup retries a failed preset load without discarding the saved selection", async ({
  page,
  request,
}, testInfo) => {
  const preset = await (await request.post("/api/prompts", { data: { name: "Recovered scene preset" } })).json();
  let allowPresets = false;
  try {
    await prepare(page, "light");
    await seedUIState(
      page,
      {
        scenePromptPreferences: {
          pov: "second_person",
          tense: "present",
          extraInstructions: "",
          promptPresetId: preset.id,
        },
      },
      "merge",
    );
    await page.route("**/api/prompts", (route) =>
      allowPresets
        ? route.continue()
        : route.fulfill({ status: 503, json: { error: "Synthetic unavailable service" } }),
    );
    await page.goto("/");
    await page.evaluate(async () => {
      const scene = (await import(
        "/src/lib/scene-generation.ts" as string
      )) as typeof import("../packages/client/src/lib/scene-generation");
      void scene.requestScenePromptPreferences();
    });
    const dialog = page.getByRole("dialog", { name: "Scene Prompt Setup", exact: true });
    const select = dialog.getByRole("combobox", { name: "Prompt preset", exact: false });
    const submit = dialog.getByRole("button", { name: "Plan Scene", exact: true });
    await expect(dialog.getByRole("alert")).toContainText("Could not load prompt presets");
    await expect(dialog.getByText("Choose another preset or None", { exact: false })).toHaveCount(0);
    await expect(select).toHaveValue(preset.id);
    await expect(submit).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("scene-preset-load-error-light.png") });
    await select.selectOption("");
    await expect(submit).toBeEnabled();
    // Reopen with the unchanged saved ID: clearing the draft must not discard the remembered selection.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.evaluate(async () => {
      const scene = (await import(
        "/src/lib/scene-generation.ts" as string
      )) as typeof import("../packages/client/src/lib/scene-generation");
      void scene.requestScenePromptPreferences();
    });
    await expect(dialog.getByRole("button", { name: "Retry loading presets", exact: true })).toBeVisible();
    allowPresets = true;
    await dialog.getByRole("button", { name: "Retry loading presets", exact: true }).click();
    await expect(select).toHaveValue(preset.id);
    await expect(select.locator("option:checked")).toHaveText("Recovered scene preset");
    await expect(submit).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("scene-preset-retry-light.png") });
  } finally {
    await page.close();
    await request.delete(`/api/prompts/${preset.id}`);
  }
});

test("Scene setup can continue with None while the preset list is loading", async ({ page }) => {
  await prepare(page, "dark");
  let releasePresets!: () => void;
  const pending = new Promise<void>((resolve) => {
    releasePresets = resolve;
  });
  await page.route("**/api/prompts", async (route) => {
    await pending;
    await route.fulfill({ json: [] });
  });
  try {
    await page.goto("/");
    await page.evaluate(async () => {
      const scene = (await import(
        "/src/lib/scene-generation.ts" as string
      )) as typeof import("../packages/client/src/lib/scene-generation");
      void scene.requestScenePromptPreferences();
    });
    const dialog = page.getByRole("dialog", { name: "Scene Prompt Setup", exact: true });
    await expect(dialog.getByRole("combobox", { name: "Prompt preset", exact: false })).toBeDisabled();
    const submit = dialog.getByRole("button", { name: "Plan Scene", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toBeHidden();
  } finally {
    releasePresets();
  }
});

test("TTS playback filters keep compatible defaults and save independent choices", async ({
  page,
  request,
}, testInfo) => {
  const original = await (await request.get("/api/tts/config")).json();
  let config = { ...original, enabled: false, skipTagContent: false, skipCodeBlocks: true, skipBracketedText: false };
  await prepare(page, "dark");
  await page.route("**/api/tts/config", async (route) => {
    if (route.request().method() === "PUT") config = route.request().postDataJSON();
    await route.fulfill({ json: config });
  });
  const open = async () => {
    await page.evaluate(async () => {
      const { useUIStore } = (await import("/src/stores/ui.store.ts" as string)) as PageUiStoreModule;
      useUIStore.setState({ rightPanel: "connections", rightPanelOpen: true });
    });
    const card = page
      .locator('[data-component="RightPanel"]')
      .getByText("Text to Speech", { exact: true })
      .locator("xpath=../../..");
    await card.getByTitle("Expand", { exact: true }).click();
    return card;
  };
  await page.goto("/");
  let card = await open();
  const tags = () => card.getByLabel("Skip text inside HTML and custom tags", { exact: true });
  const code = () => card.getByLabel("Skip fenced code blocks", { exact: true });
  const brackets = () => card.getByLabel("Skip text inside square brackets", { exact: true });
  await expect(tags()).not.toBeChecked();
  await expect(code()).toBeChecked();
  await expect(brackets()).not.toBeChecked();
  await card.getByText("Skip text inside HTML and custom tags", { exact: true }).click();
  await expect.poll(() => config.skipTagContent).toBe(true);
  await card.getByText("Skip fenced code blocks", { exact: true }).click();
  await expect.poll(() => config.skipCodeBlocks).toBe(false);
  await card.getByText("Skip text inside square brackets", { exact: true }).click();
  await expect.poll(() => config.skipBracketedText).toBe(true);
  await brackets().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("tts-filters-dark.png") });
  await page.reload();
  card = await open();
  await expect(tags()).toBeChecked();
  await expect(code()).not.toBeChecked();
  await expect(brackets()).toBeChecked();
});

test("Game dice narration failures offer regeneration and Peek keeps planner usage separate", async ({
  page,
  request,
}, testInfo) => {
  const chat = await (
    await request.post("/api/chats", {
      data: { name: "Dice outcome recovery", mode: "game", characterIds: [], connectionId: "synthetic-connection" },
    })
  ).json();
  try {
    await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: { enableAgents: false, gameId: chat.id, gameSessionStatus: "active", gameIntroPresented: true },
    });
    const historical = await request.post(`/api/chats/${chat.id}/messages`, {
      data: {
        role: "assistant",
        content: "The old gate waits.",
        extra: {
          cachedPrompt: [{ role: "system", content: "Narrate the outcome." }],
          gameToolPlanning: {
            provider: "openai",
            model: "cheap-planner",
            usage: { promptTokens: 7, completionTokens: 3 },
          },
        },
      },
    });
    const historicalId = (await historical.json()).id;
    await request.patch(`/api/chats/${chat.id}/messages/${historicalId}/extra`, {
      data: { generationInfo: { provider: "google", model: "narrator", tokensPrompt: 11 } },
    });
    await request.post(`/api/chats/${chat.id}/messages`, { data: { role: "user", content: "Open the gate." } });
    const failed = await (
      await request.post(`/api/chats/${chat.id}/messages`, {
        data: {
          role: "assistant",
          content: "[dice: 3d1+2 = 5 (1 + 1 + 1 + 2)]",
          extra: {
            gameOutcomeNarrationFailed: true,
            diceRollResults: [{ notation: "3d1+2", rolls: [1, 1, 1], modifier: 2, total: 5 }],
          },
        },
      })
    ).json();
    await prepare(page, "dark");
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      gameInstantTextReveal: true,
      gameDialogueDisplayMode: "stacked",
      theme: "dark",
    });
    await page.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chat.id);
    let regeneratedId: string | undefined;
    await page.route("**/api/generate", (route) => {
      regeneratedId = route.request().postDataJSON().regenerateMessageId;
      return route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "done", data: {} })}\n\n`,
      });
    });
    await page.goto("/");
    const failure = page.getByRole("status").filter({ hasText: "The Game Master could not narrate the dice outcome." });
    await expect(failure).toBeVisible();
    await expect(failure.getByRole("button", { name: "Regenerate turn", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("game-dice-outcome-failure-dark.png") });
    await page.locator('[data-component="GameNarration.PeekPrompt"]').first().click();
    await expect(page.getByRole("heading", { name: "Assembled Prompt", exact: true })).toBeVisible();
    await expect(page.getByText("Tool planner: openai / cheap-planner", { exact: true })).toBeVisible();
    await expect(page.getByText("7 input / 3 output tokens", { exact: true })).toBeVisible();
    await expect(page.getByText(/11 actual prompt tokens/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("game-peek-planner-dark.png") });
    await page.getByRole("button", { name: "Close assembled prompt", exact: true }).click();
    await failure.getByRole("button", { name: "Regenerate turn", exact: true }).click();
    await expect.poll(() => regeneratedId).toBe(failed.id);
  } finally {
    await page.close();
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
