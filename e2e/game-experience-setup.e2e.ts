import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const isNewGame of [true, false]) {
  test(`Experience wizard preserves ordinary steps and import scope (${isNewGame ? "new" : "existing"} game)`, async ({
    page,
  }, testInfo) => {
    // Includes legacy setup, file import and two passes through all seven steps.
    if (isNewGame) test.setTimeout(120_000);
    const experience = {
      id: "setup-fixture",
      version: "1.0.0",
      status: "active",
      readiness: "ready",
      manifest: {
        schemaVersion: 2,
        id: "setup-fixture",
        name: "Setup fixture",
        version: "1.0.0",
        capabilityApi: { major: 1, minor: 18 },
        kind: ["agent"],
        entrypoints: { client: "client.mjs" },
        contributions: {
          slots: ["game-surface"],
          gameSurface: {
            setup: {
              seed: { key: "worldSeed" },
              config: { generate: true },
              requires: { enableCustomWidgets: false },
            },
          },
        },
        permissions: ["ui"],
      },
    };
    const books = [
      { id: "free-book", name: "Unattached lore", enabled: true },
      { id: "excluded-book", name: "Excluded lore", enabled: true },
      { id: "disabled-book", name: "Disabled lore", enabled: false },
    ];
    await page.route("**/api/capability-packages/installed", (route) =>
      route.fulfill({
        json: [
          experience,
          {
            ...experience,
            id: "legacy-fixture",
            manifest: {
              ...experience.manifest,
              id: "legacy-fixture",
              name: "Legacy fixture",
              contributions: { slots: ["game-surface"] },
            },
          },
        ],
      }),
    );
    await page.route("**/api/capability-packages/agents", (route) =>
      route.fulfill({
        json: [
          {
            id: "hierarchical-maps",
            name: "World Maps",
            description: "Fixture",
            phase: "post_generation",
            category: "tracker",
          },
        ],
      }),
    );
    await page.route("**/api/capability-packages/*/client?*", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `for (const id of ['setup-fixture','legacy-fixture']) {
        const tag = 'marinara-capability-' + id;
        if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
          connectedCallback() { this.textContent = 'Legacy package setup fixture'; }
        });
      }`,
      }),
    );
    await page.route("**/api/connections", (route) =>
      route.fulfill({
        json: [
          { id: "wizard-connection", name: "Wizard connection", provider: "custom", model: "fixture", isDefault: true },
        ],
      }),
    );
    await page.route("**/api/lorebooks", (route) => route.fulfill({ json: books }));
    let failEntryFetch = true;
    await page.route("**/api/lorebooks/free-book/entries", (route) =>
      failEntryFetch
        ? route.fulfill({ status: 503, json: { error: "Temporary entry loading failure" } })
        : route.fulfill({
            json: [
              {
                id: "keyword-entry",
                lorebookId: "free-book",
                name: "Keyword entry",
                enabled: true,
                constant: false,
                order: 0,
              },
              {
                id: "constant-entry",
                lorebookId: "free-book",
                name: "Constant entry",
                enabled: true,
                constant: true,
                order: 1,
              },
              { id: "disabled-entry", lorebookId: "free-book", name: "Disabled entry", enabled: false, order: 2 },
              {
                id: "chat-disabled-entry",
                lorebookId: "free-book",
                name: "Chat disabled entry",
                enabled: true,
                order: 3,
              },
            ],
          }),
    );
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: testInfo.project.name === "desktop-chromium" ? "light" : "dark",
    });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
    await page.goto("/");
    await page.evaluate(
      async ({ isNewGame }) => {
        const { GameSetupWizard } = await import("/src/components/game/GameSetupWizard.tsx" as string);
        const dependencyUrl = (name: string) =>
          performance
            .getEntriesByType("resource")
            .find((entry) => new URL(entry.name).pathname.endsWith(`/deps/${name}.js`))!.name;
        const { default: React } = await import(dependencyUrl("react"));
        const { default: ReactDOM } = await import(dependencyUrl("react-dom_client"));
        const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
        const container = document.createElement("div");
        document.body.append(container);
        const result = document.createElement("output");
        result.dataset.testid = "wizard-result";
        container.append(result);
        ReactDOM.createRoot(container).render(
          React.createElement(
            QueryClientProvider,
            { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
            React.createElement(GameSetupWizard, {
              activeChatId: "wizard-chat",
              isNewGame,
              chatMetadata: {
                excludedLorebookIds: ["excluded-book"],
                entryStateOverrides: { "chat-disabled-entry": { enabled: false } },
              },
              onSetupError: () => false,
              onCancel: () => {},
              isLoading: false,
              isDraftingMap: false,
              isLinkingSharedWorld: false,
              characters: [{ id: "party-fixture", name: "Companion fixture" }],
              onComplete: (
                config: unknown,
                _preferences: unknown,
                _connections: unknown,
                _name: unknown,
                mapPlan: unknown,
              ) => {
                const output =
                  document.querySelector('[data-testid="wizard-result"]') ??
                  document.body.appendChild(document.createElement("output"));
                output.setAttribute("data-testid", "wizard-result");
                output.textContent = JSON.stringify({ config, mapPlan });
              },
            }),
          ),
        );
      },
      { isNewGame },
    );
    const wizard = page.locator('[data-component="GameSetupWizard"]');
    await expect(wizard).toBeVisible();
    const next = () => wizard.getByRole("button", { name: "Next", exact: true }).click();
    const back = () => wizard.getByRole("button", { name: "Back", exact: true }).click();
    if (isNewGame) {
      await page.screenshot({ path: testInfo.outputPath("setup-before-experience.png") });
      await expect(wizard.getByRole("button", { name: "Import setup", exact: true })).toBeEnabled();
      await wizard
        .locator('input[type="file"]')
        .first()
        .setInputFiles({
          name: "legacy.marinara-game-setup.json",
          mimeType: "application/json",
          buffer: Buffer.from(
            JSON.stringify({
              format: "marinara-game-setup",
              version: 1,
              gameName: "Imported legacy adventure",
              setup: {
                config: {
                  genre: "Fantasy",
                  setting: "Legacy Harbor",
                  tone: "Hopeful",
                  difficulty: "Normal",
                  rating: "sfw",
                  gmMode: "standalone",
                  partyCharacterIds: [],
                  playerGoals: "Find the missing keeper",
                  gameExperienceId: "legacy-fixture",
                  experienceConfig: { stalePackageState: "discard me" },
                },
              },
            }),
          ),
        });
      const legacy = page.getByRole("dialog", { name: "Legacy fixture", exact: true });
      await expect(legacy).toBeVisible();
      await expect(legacy.getByText("Legacy package setup fixture", { exact: true })).toBeVisible();
      await expect(legacy).toHaveCSS("opacity", "1");
      await page.screenshot({ path: testInfo.outputPath("setup-imported-legacy-experience.png") });
      await expect(legacy.getByRole("button", { name: "Close setup", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(legacy.getByRole("button", { name: "Back", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(legacy.getByRole("button", { name: "Close setup", exact: true })).toBeFocused();
      await legacy.getByRole("button", { name: "Back", exact: true }).click();
      await expect(wizard).toBeFocused();
      await expect(wizard.getByText(/The saved Experience is unavailable/u)).toHaveCount(0);
      await wizard.getByRole("button", { name: "Show", exact: true }).click();
      await wizard.getByRole("switch", { name: "Setup fixture", exact: true }).click();
      await wizard.getByRole("spinbutton", { name: "World seed" }).fill("");
      await expect(wizard.getByRole("alert")).toHaveText("Enter a valid numeric seed before starting.");
      await wizard.getByRole("button", { name: "Randomize", exact: true }).click();
      await expect(wizard.getByRole("spinbutton", { name: "World seed" })).not.toHaveValue("");
      await wizard.getByRole("spinbutton", { name: "World seed" }).fill("4242");
      await page.screenshot({ path: testInfo.outputPath("setup-inline-experience.png") });
    } else {
      await expect(wizard.getByText("Experiences", { exact: true })).toHaveCount(0);
    }
    // Import carries only the numeric seed and keeps all the built-in steps.
    await wizard
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "fixture.marinara-game-setup.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            format: "marinara-game-setup",
            version: 1,
            gameName: "Imported adventure",
            gmConnectionId: "wizard-connection",
            setup: {
              config: {
                genre: "Fantasy",
                setting: "Copper Harbor",
                tone: "Hopeful",
                difficulty: "Normal",
                rating: "sfw",
                gmMode: "standalone",
                partyCharacterIds: ["party-fixture"],
                playerGoals: "Find the missing keeper",
                enableAgents: true,
                gameExperienceId: "setup-fixture",
                experienceConfig: { worldSeed: 7, stalePackageState: "discard me", generate: false },
                activeLorebookEntryIds: ["keyword-entry", "missing-entry"],
              },
            },
          }),
        ),
      });
    if (isNewGame) {
      await expect(wizard.getByRole("spinbutton", { name: "World seed" })).toHaveValue("7");
      await wizard.getByRole("switch", { name: "Setup fixture", exact: true }).click();
      await expect(wizard.getByRole("switch", { name: "Setup fixture", exact: true })).toBeVisible();
      await wizard.getByRole("switch", { name: "Setup fixture", exact: true }).click();
    } else
      await expect(
        wizard.getByText("The Experience and seed were skipped. They can only be selected for a new game."),
      ).toBeVisible();
    await next();
    await expect(wizard.getByRole("heading", { name: "World", exact: true })).toBeVisible();
    await next();
    await expect(wizard.getByRole("heading", { name: "Party", exact: true })).toBeVisible();
    await expect(wizard.getByText("Companion fixture", { exact: true }).first()).toBeVisible();
    await next();
    await expect(wizard.getByRole("heading", { name: "Goals", exact: true })).toBeVisible();
    await next();
    await wizard.getByRole("button", { name: "Select individual entries", exact: true }).click();
    await expect(wizard.getByRole("alert")).toContainText("Could not load the entries.");
    await next();
    await next();
    await expect(wizard.getByRole("button", { name: /Start/u })).toBeDisabled();
    await back();
    await expect(wizard.getByRole("heading", { name: "Features", exact: true })).toBeVisible();
    await back();
    await expect(wizard.getByRole("heading", { name: "Lorebooks", exact: true })).toBeVisible();
    failEntryFetch = false;
    await wizard.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(wizard.getByRole("alert")).toHaveCount(0);
    await wizard.locator("summary").filter({ hasText: "Unattached lore" }).click();
    await expect(wizard.getByRole("checkbox")).toHaveCount(2);
    await expect(wizard.getByRole("checkbox").first()).toHaveAccessibleName("Constant entry");
    await expect(wizard.getByRole("checkbox", { name: "Keyword entry", exact: true })).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("setup-lore-entry-picker.png") });
    await next();
    await expect(wizard.getByRole("heading", { name: "Features", exact: true })).toBeVisible();
    if (isNewGame) {
      await expect(
        wizard.getByText("Setup fixture uses HUD widgets disabled. You can change this setting."),
      ).toBeVisible();
      await wizard.getByRole("button", { name: /^Custom HUD Widgets/u }).click();
      await expect(wizard.getByText("Setup fixture expects HUD widgets disabled; your choice is kept.")).toBeVisible();
      await expect(wizard.getByText("Hierarchical world map", { exact: true })).toHaveCount(0);
    } else {
      await expect(wizard.getByText("Hierarchical world map", { exact: true })).toBeVisible();
    }
    await next();
    await expect(wizard.getByRole("heading", { name: "GM", exact: true })).toBeVisible();
    await wizard.getByRole("button", { name: /Start/u }).click();
    const result = JSON.parse((await page.getByTestId("wizard-result").textContent()) ?? "{}");
    expect(result.config.partyCharacterIds).toEqual(["party-fixture"]);
    expect(result.config.playerGoals).toBe("Find the missing keeper");
    expect(result.config.activeLorebookEntryIds).toEqual(["keyword-entry"]);
    expect(result.config.activeLorebookIds).toBeUndefined();
    expect(result.mapPlan).toBeUndefined();
    if (isNewGame) {
      expect(result.config.gameExperienceId).toBe("setup-fixture");
      expect(result.config.experienceConfig).toEqual({ worldSeed: 7, generate: true });
      // Starting cannot serialize an invalid seed.
      for (let step = 0; step < 6; step++) await back();
      await wizard.getByRole("spinbutton", { name: "World seed" }).fill("");
      for (let step = 0; step < 6; step++) await next();
      await expect(wizard.getByRole("button", { name: /Start/u })).toBeDisabled();
    } else {
      expect(result.config).not.toHaveProperty("gameExperienceId");
      expect(result.config).not.toHaveProperty("experienceConfig");
    }
  });
}
