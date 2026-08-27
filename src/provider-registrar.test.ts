/**
 * copilot-auto — ProviderRegistrar anchor-policy tests.
 *
 * Endpoint-aware anchor selection (DESIGN §8/§9.4): the session pool is
 * grouped by endpoint descriptor (api + normalized base URL) from catalog
 * metadata — the selected_model's endpoint wins, then the largest group,
 * then the load-phase default. Cross-family ids are never picked, and the
 * shell model carries the chosen endpoint (api + account-specific
 * baseUrl) so mai-code-1.1-flash is never sent to /chat/completions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_MODEL_ID,
  buildAutoModel,
  catalogDescriptors,
  pickAnchorDescriptor,
} from "./provider-registrar.ts";
import { DEFAULT_COPILOT_DESCRIPTOR } from "./capi-client.ts";
import type { AutoSession, CopilotCatalogModel, EndpointDescriptor, ExtensionCtx } from "./types.ts";

const BASE = "https://api.githubcopilot.com";
const INDIVIDUAL = "https://api.individual.githubcopilot.com";

const CATALOG = new Map<string, EndpointDescriptor>([
  ["mai-code-1.1-flash", { api: "openai-responses", baseUrl: INDIVIDUAL }],
  ["gpt-5.4", { api: "openai-responses", baseUrl: INDIVIDUAL }],
  ["gemini-3.1-pro-preview", { api: "openai-completions", baseUrl: INDIVIDUAL }],
  ["gemini-3.5-flash", { api: "openai-completions", baseUrl: INDIVIDUAL }],
  ["claude-sonnet-4-6", { api: "anthropic-messages", baseUrl: BASE }],
  ["grok-4.5", { api: "openai-responses", baseUrl: BASE }],
]);

function session(overrides: Partial<AutoSession> = {}): AutoSession {
  return {
    selectedModelID: "mai-code-1.1-flash",
    sessionToken: "t",
    availableModels: ["mai-code-1.1-flash", "gpt-5.4"],
    discountedCosts: {},
    expiresAtMs: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

test("mai pool + catalog metadata selects the responses anchor and the account-specific baseUrl", () => {
  const s = session({
    selectedModelID: "mai-code-1.1-flash",
    availableModels: ["mai-code-1.1-flash", "gemini-3.1-pro-preview", "claude-sonnet-4-6"],
  });
  const anchor = pickAnchorDescriptor(s, CATALOG);
  assert.deepEqual(anchor, { api: "openai-responses", baseUrl: INDIVIDUAL });
});

test("selected_model's endpoint wins over the largest pool group", () => {
  // Three completions models vs one responses model — but the server
  // selected the responses model: the anchor follows the selection.
  const s = session({
    selectedModelID: "mai-code-1.1-flash",
    availableModels: [
      "mai-code-1.1-flash",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gpt-4.1",
    ],
  });
  const anchor = pickAnchorDescriptor(s, CATALOG);
  assert.deepEqual(anchor, { api: "openai-responses", baseUrl: INDIVIDUAL });
});

test("without catalog metadata the heuristic groups pool ids; unknown ids are dropped", () => {
  // Heuristic: mai → responses, gemini → completions, grok → unknown.
  const s = session({
    selectedModelID: "mai-code-9.9-flash",
    availableModels: ["mai-code-9.9-flash", "gemini-3.1-pro-preview", "grok-4.5"],
  });
  const anchor = pickAnchorDescriptor(s, new Map());
  assert.deepEqual(anchor, { api: "openai-responses", baseUrl: INDIVIDUAL }, "mai heuristic anchors responses");
});

test("unknown pool ids never anchor cross-family; empty pool falls back to the default", () => {
  const unknownOnly = pickAnchorDescriptor(session({ availableModels: ["grok-4.5"] }), new Map());
  assert.deepEqual(unknownOnly, DEFAULT_COPILOT_DESCRIPTOR, "unknown id contributes no group → default");
  const noSession = pickAnchorDescriptor(undefined, CATALOG);
  assert.deepEqual(noSession, DEFAULT_COPILOT_DESCRIPTOR);
});

test("anthropic pool anchors anthropic even when responses group is larger", () => {
  const s = session({
    selectedModelID: "claude-sonnet-4-6",
    availableModels: ["claude-sonnet-4-6", "claude-opus-4-6", "mai-code-1.1-flash"],
  });
  const anchor = pickAnchorDescriptor(s, CATALOG);
  assert.deepEqual(anchor, { api: "anthropic-messages", baseUrl: BASE });
});

test("catalogDescriptors indexes only github-copilot entries with a supported api", () => {
  const ctx: ExtensionCtx = {
    hasUI: true,
    ui: { setStatus: () => {} },
    models: {
      list: (): CopilotCatalogModel[] => [
        { provider: "github-copilot", id: "mai-code-1.1-flash", api: "openai-responses", baseUrl: INDIVIDUAL },
        { provider: "github-copilot", id: "gpt-5.4", api: "openai-responses", baseUrl: INDIVIDUAL },
        { provider: "other-provider", id: "gpt-5.4", api: "openai-responses", baseUrl: BASE },
        { provider: "github-copilot", id: "unsupported-api", api: "made-up-api", baseUrl: BASE },
        { provider: "github-copilot", id: "no-base-url", api: "openai-responses" },
        { provider: "github-copilot", id: "no-api", baseUrl: BASE },
      ],
    },
  };
  const catalog = catalogDescriptors(ctx);
  assert.equal(catalog.size, 2, "only github-copilot + supported api + baseUrl entries are indexed");
  assert.deepEqual(catalog.get("mai-code-1.1-flash"), { api: "openai-responses", baseUrl: INDIVIDUAL });
  assert.equal(catalog.get("no-base-url"), undefined);
});

test("buildAutoModel carries the anchor endpoint on the shell model", () => {
  const responses = buildAutoModel({ api: "openai-responses", baseUrl: INDIVIDUAL });
  assert.equal(responses.id, AUTO_MODEL_ID);
  assert.equal(responses.api, "openai-responses");
  assert.equal(responses.baseUrl, INDIVIDUAL);
  assert.equal(responses.compat, undefined, "catalog responses models carry no compat overrides");

  const completions = buildAutoModel({ api: "openai-completions", baseUrl: INDIVIDUAL });
  assert.equal(completions.api, "openai-completions");
  assert.equal(completions.baseUrl, INDIVIDUAL);
  assert.deepEqual(completions.compat, {
    strictResponsesPairing: true,
    supportsDeveloperRole: false,
    supportsImageDetailOriginal: false,
  });

  const anthropic = buildAutoModel({ api: "anthropic-messages", baseUrl: BASE });
  assert.equal(anthropic.api, "anthropic-messages");
  assert.equal(anthropic.baseUrl, `${BASE}/v1`, "anthropic anchor keeps the /v1 the SDK appends /messages to");
});
