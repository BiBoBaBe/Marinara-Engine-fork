import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AdvancedMemoryStatus } from "@marinara-engine/shared";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

test("Roleplay wizard reuses automatic memory settings without downloaded agents", async ({ page, request }, info) => {
  const connectionResponse = await request.post("/api/connections", {
    data: { name: "Wizard memory proof", provider: "custom", model: "synthetic-model" },
  });
  expect(connectionResponse.ok()).toBeTruthy();
  const connection = (await connectionResponse.json()) as { id: string };
  const chatResponse = await request.post("/api/chats", {
    data: { name: "Automatic memory setup", mode: "roleplay", connectionId: connection.id },
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()) as { id: string };
  const status = async () => {
    const response = await request.get(`/api/chats/${chat.id}/advanced-memory`);
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as AdvancedMemoryStatus;
  };
  try {
    expect(
      (await request.patch(`/api/chats/${chat.id}/metadata`, { data: { enableAgents: false } })).ok(),
    ).toBeTruthy();
    for (const endpoint of ["capability-packages/agents", "capability-packages/installed", "agents"]) {
      await page.route(`**/api/${endpoint}`, (route) => route.fulfill({ json: [] }));
    }
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      chatWizardDefaults: {},
    });
    await page.addInitScript(
      ({ chatId, version }) => {
        localStorage.setItem("marinara-active-chat-id", chatId);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { chatId: chat.id, version },
    );
    await page.goto("/");
    await expect(page.locator("textarea[data-chat-composer]")).toBeVisible();
    await page.evaluate(async () => {
      const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
      useChatStore.getState().setShouldOpenWizard(true);
      useChatStore.getState().setShouldOpenSettings(true);
    });
    const wizard = page.locator('[data-component="ChatSetupWizard"]');
    await expect(wizard).toBeVisible();
    const next = wizard.getByRole("button", { name: "Next", exact: true });
    await next.click();
    await expect(wizard.getByRole("heading", { name: "Pick a Preset", exact: true })).toBeVisible();
    await wizard.getByRole("combobox", { name: "Preset", exact: true }).click();
    await wizard
      .getByRole("listbox", { name: "Preset", exact: true })
      .getByRole("option", { name: "None", exact: true })
      .click();
    await next.click();
    await expect(wizard.getByRole("heading", { name: "Persona & Characters", exact: true })).toBeVisible();
    await next.click();
    await expect(wizard.getByRole("heading", { name: "Attach Lorebooks", exact: true })).toBeVisible();
    await next.click();
    await expect(wizard.getByRole("heading", { name: "Enable Agents", exact: true })).toBeVisible();
    await expect(wizard.locator('[data-component="ChatSetupWizard.AgentEmptyState"]')).toBeVisible();
    const agentsToggle = wizard.getByRole("switch", { name: /^Enable Agents/ });
    await expect(agentsToggle).toHaveAttribute("aria-checked", "false");
    const memory = wizard.locator('[data-component="AdvancedMemorySettings"]');
    const toggle = memory.getByRole("checkbox", { name: /Automatic context and memory handling \(alpha\)/ });
    await expect(toggle).not.toBeChecked();
    await expect(memory.getByLabel("Maximum allowed context before compression (tokens)")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("memory-wizard-disabled.png"), animations: "disabled" });
    await memory.getByText("Automatic context and memory handling (alpha)", { exact: true }).click();
    await expect.poll(async () => (await status()).settings.enabled).toBe(true);
    const context = memory.getByLabel("Maximum allowed context before compression (tokens)");
    await expect(context).toBeEnabled();
    await context.fill("16000");
    await context.press("Enter");
    await expect.poll(async () => (await status()).settings.maxContextTokens).toBe(16000);
    const maximum = memory.getByLabel("Maximum messages per excerpt", { exact: true });
    await expect(maximum).toBeEnabled();
    await maximum.fill("0");
    await maximum.press("Enter");
    await expect
      .poll(async () => {
        const { retrieveMinMessages, retrieveMaxMessages } = (await status()).settings;
        return [retrieveMinMessages, retrieveMaxMessages];
      })
      .toEqual([0, 0]);
    await expect(memory.getByLabel("Minimum messages per excerpt", { exact: true })).toHaveValue("0");
    await expect(memory.getByText(/^Turning this on in an existing chat/)).toHaveCount(0);
    await memory.getByText("Moving context", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("memory-wizard-enabled.png"), animations: "disabled" });
    // Returning to the step re-reads the same saved form settings.
    await wizard.getByRole("button", { name: "Back", exact: true }).click();
    await expect(wizard.getByRole("heading", { name: "Attach Lorebooks", exact: true })).toBeVisible();
    await next.click();
    await expect(toggle).toBeChecked();
    await expect(context).toHaveValue("16000");
    await expect(maximum).toHaveValue("0");
    await expect(agentsToggle).toHaveAttribute("aria-checked", "false");
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`);
    await request.delete(`/api/connections/${connection.id}`);
  }
});
