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
  ProviderRegistrar,
} from "./provider-registrar.ts";
import { DEFAULT_COPILOT_DESCRIPTOR } from "./capi-client.ts";
import type { CapiClient } from "./capi-client.ts";
import type {
  AutoSession,
  CopilotCatalogModel,
  EndpointDescriptor,
  ExtensionAPI,
  ExtensionCtx,
  LoggerLike,
} from "./types.ts";

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

test("catalogDescriptors falls back to modelRegistry.getAll() when ctx.models is absent (Pi)", () => {
  // Pi exposes the registry snapshot as ctx.modelRegistry.getAll()
  // (Model[] with provider/id/api/baseUrl); ctx.models does not exist.
  const ctx: ExtensionCtx = {
    hasUI: true,
    ui: { setStatus: () => {} },
    modelRegistry: {
      getApiKeyForProvider: async () => "bearer",
      getAll: (): CopilotCatalogModel[] => [
        { provider: "github-copilot", id: "mai-code-1.1-flash", api: "openai-responses", baseUrl: INDIVIDUAL },
        { provider: "github-copilot", id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: BASE },
        { provider: "other-provider", id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: BASE },
      ],
    },
  };
  const catalog = catalogDescriptors(ctx);
  assert.equal(catalog.size, 2, "getAll entries are indexed with provider/id/api/baseUrl preserved");
  assert.deepEqual(catalog.get("mai-code-1.1-flash"), { api: "openai-responses", baseUrl: INDIVIDUAL });
  assert.deepEqual(catalog.get("claude-sonnet-4-6"), { api: "anthropic-messages", baseUrl: BASE });
});

test("catalogDescriptors falls back to scopedModels when models and getAll are absent (Pi)", () => {
  // Pi also exposes ctx.scopedModels ({ model, thinkingLevel? }[]).
  const ctx: ExtensionCtx = {
    hasUI: true,
    ui: { setStatus: () => {} },
    scopedModels: [
      { model: { provider: "github-copilot", id: "gpt-5.4", api: "openai-responses", baseUrl: INDIVIDUAL } },
      { model: { provider: "github-copilot", id: "mai-code-1.1-flash", api: "openai-responses", baseUrl: INDIVIDUAL } },
    ],
  };
  const catalog = catalogDescriptors(ctx);
  assert.equal(catalog.size, 2);
  assert.deepEqual(catalog.get("gpt-5.4"), { api: "openai-responses", baseUrl: INDIVIDUAL });
});

test("catalogDescriptors prefers ctx.models.list() when both surfaces exist (OMP)", () => {
  // OMP exposes BOTH ctx.models.list() and (structurally) a
  // modelRegistry — list() is the live registry view and must win so
  // OMP endpoint routing does not regress.
  const ctx: ExtensionCtx = {
    hasUI: true,
    ui: { setStatus: () => {} },
    modelRegistry: {
      getApiKeyForProvider: async () => "bearer",
      getAll: (): CopilotCatalogModel[] => [
        { provider: "github-copilot", id: "stale-entry", api: "openai-responses", baseUrl: BASE },
      ],
    },
    models: {
      list: (): CopilotCatalogModel[] => [
        { provider: "github-copilot", id: "mai-code-1.1-flash", api: "openai-responses", baseUrl: INDIVIDUAL },
      ],
    },
  };
  const catalog = catalogDescriptors(ctx);
  assert.equal(catalog.size, 1, "only ctx.models.list() entries are indexed");
  assert.deepEqual(catalog.get("mai-code-1.1-flash"), { api: "openai-responses", baseUrl: INDIVIDUAL });
  assert.equal(catalog.get("stale-entry"), undefined);
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

// ── Generation-based cancellation tests ──────────────────────────────

/** Minimal CapiClient stub: registrar only invokes fetchAutoSession. */
type RegistrarTestClient = Pick<CapiClient, "fetchAutoSession">;

function stubClient(fetchResult?: AutoSession): RegistrarTestClient {
  return {
    fetchAutoSession: async () => fetchResult,
  };
}

function stubLogger(): { logger: LoggerLike; logs: string[] } {
  const logs: string[] = [];
  return { logger: { log: (message: string) => { logs.push(message); } }, logs };
}

function makeRegistrar(client: RegistrarTestClient, logger: LoggerLike): ProviderRegistrar {
  // Test seam: ProviderRegistrar uses only fetchAutoSession from CapiClient.
  return new ProviderRegistrar(client as unknown as CapiClient, logger, 2000);
}

function testExtensionApi(onRegister: (providerId: string) => void): ExtensionAPI {
  // Test seam: registrar only invokes ExtensionAPI.registerProvider.
  return { registerProvider: onRegister } as unknown as ExtensionAPI;
}

/** Build a minimal ctx with a working credential and optional modelRegistry
 *  refresh/background stubs. */
function stubCtx(overrides: Partial<ExtensionCtx> = {}): ExtensionCtx {
  return {
    hasUI: true,
    ui: { setStatus: () => {} },
    modelRegistry: {
      getApiKeyForProvider: async () => "bearer-token",
      refreshInBackground: () => {},
      awaitBackgroundRefresh: async () => {},
    },
    sessionManager: { getSessionId: () => "session-1" },
    ...overrides,
  };
}

test("reset increments generation and drops stale in-flight doRegister result", async () => {
  // Arrange: build a doRegister that stalls on a deferred promise so we
  // can call reset() mid-flight.
  let resolveProbe!: (value: AutoSession | undefined) => void;
  const probeDeferred = new Promise<AutoSession | undefined>((resolve) => { resolveProbe = resolve; });
  const client = stubClient();
  // Override fetchAutoSession to stall on the deferred promise.
  client.fetchAutoSession = async () => probeDeferred;
  const { logger, logs } = stubLogger();
  const reg = makeRegistrar(client, logger);
  const registrations: string[] = [];
  const pi = testExtensionApi((providerId) => {
    registrations.push(providerId);
  });
  const ctx = stubCtx();

  // Act: start a registration (will stall on probeDeferred).
  const p1 = reg.register(pi, ctx);
  // Reset while in-flight — bumps generation.
  reg.reset();
  // Resolve the stalled probe so doRegister continues.
  resolveProbe(session());
  const result = await p1;

  // Assert: the stale result was dropped.
  assert.equal(result.registered, false, "stale in-flight result is dropped after reset");
  assert.equal(registrations.length, 0, "registerProvider must NOT be called for a superseded generation");
  assert.ok(logs.some((l) => l.includes("superseded")), "log indicates registration was superseded");
});

test("reset does not clobber a new generation's inflight reference", async () => {
  // Arrange: two successive registrations.  The first stalls; reset is
  // called; the second starts fresh.
  let resolveProbe1!: (value: AutoSession | undefined) => void;
  const deferred1 = new Promise<AutoSession | undefined>((resolve) => { resolveProbe1 = resolve; });
  let resolveProbe2!: (value: AutoSession | undefined) => void;
  const deferred2 = new Promise<AutoSession | undefined>((resolve) => { resolveProbe2 = resolve; });
  let callCount = 0;
  const client = stubClient();
  client.fetchAutoSession = async () => {
    callCount++;
    return callCount === 1 ? deferred1 : deferred2;
  };
  const { logger } = stubLogger();
  const reg = makeRegistrar(client, logger);
  const registered: string[] = [];
  const pi = testExtensionApi((providerId) => {
    registered.push(providerId);
  });
  const ctx = stubCtx();

  // Start first registration, then reset, then start second.
  const p1 = reg.register(pi, ctx);
  reg.reset();
  const p2 = reg.register(pi, ctx);

  // Resolve both stalled probes.
  resolveProbe1(session());
  resolveProbe2(session());
  const [r1, r2] = await Promise.all([p1, p2]);

  // Assert: first was dropped, second succeeded, registerProvider called once.
  assert.equal(r1.registered, false, "first (stale) registration is dropped");
  assert.equal(r2.registered, true, "second (current) registration succeeds");
  assert.equal(registered.length, 1, "registerProvider called exactly once (for the current generation)");
});

test("deferred-promise regression: stale finally does not clear a newer inflight", async () => {
  // This specifically tests that the generation guard in .finally() prevents
  // the old registration from clobbering this.inflight when it settles.
  let resolve1!: (value: AutoSession | undefined) => void;
  const deferred1 = new Promise<AutoSession | undefined>((resolve) => { resolve1 = resolve; });
  let resolve2!: (value: AutoSession | undefined) => void;
  const deferred2 = new Promise<AutoSession | undefined>((resolve) => { resolve2 = resolve; });
  let callCount = 0;
  const client = stubClient();
  client.fetchAutoSession = async () => {
    callCount++;
    return callCount === 1 ? deferred1 : deferred2;
  };
  const { logger } = stubLogger();
  const reg = makeRegistrar(client, logger);
  const pi = testExtensionApi(() => {});
  const ctx = stubCtx();

  // Start first registration (stalls).
  const p1 = reg.register(pi, ctx);
  // Reset — generation bumps; the old .finally must NOT clear inflight.
  reg.reset();
  // Start second registration (should create a new inflight slot).
  const p2 = reg.register(pi, ctx);
  // Resolve first — its .finally fires but must leave inflight intact.
  resolve1(session());
  await p1;
  // Second should still be in-flight and resolvable.
  resolve2(session());
  const r2 = await p2;
  assert.equal(r2.registered, true, "second registration completes despite first settling");
});
