/**
 * copilot-auto — IntentRouter tests.
 *
 * Endpoint fingerprinting (api + normalized base URL, catalog metadata
 * first, conservative heuristic for unknown ids), sticky decision reuse,
 * turn-0 intent routing with endpoint filtering, endpoint-clamped
 * fallbacks (DESIGN §2.3/§8 — a responses-family id is never sent to
 * chat-completions and vice versa), and boost-only reasoning shaping for
 * all three wire APIs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { IntentRouter } from "./intent-router.ts";
import { CapiClient } from "./capi-client.ts";
import type { AutoSession, ConvState, EndpointDescriptor, LoggerLike, WirePayload } from "./types.ts";

const silentLogger: LoggerLike = { log: () => undefined };
const BASE = "https://api.githubcopilot.com";
const INDIVIDUAL = "https://api.individual.githubcopilot.com";

/** Live-catalog endpoint metadata (models.db github-copilot cache). */
const CATALOG = new Map<string, EndpointDescriptor>([
  ["mai-code-1.1-flash", { api: "openai-responses", baseUrl: INDIVIDUAL }],
  ["gpt-5.4", { api: "openai-responses", baseUrl: INDIVIDUAL }],
  ["gpt-5.4-codex", { api: "openai-responses", baseUrl: INDIVIDUAL }],
  ["gemini-3.1-pro-preview", { api: "openai-completions", baseUrl: INDIVIDUAL }],
  ["gpt-4.1", { api: "openai-completions", baseUrl: INDIVIDUAL }],
  ["claude-sonnet-4-6", { api: "anthropic-messages", baseUrl: BASE }],
  ["grok-4.5", { api: "openai-responses", baseUrl: BASE }],
]);

const RESPONSES_ANCHOR: EndpointDescriptor = { api: "openai-responses", baseUrl: INDIVIDUAL };
const COMPLETIONS_ANCHOR: EndpointDescriptor = { api: "openai-completions", baseUrl: INDIVIDUAL };
const ANTHROPIC_ANCHOR: EndpointDescriptor = { api: "anthropic-messages", baseUrl: `${BASE}/v1` };

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function withFetch(mock: FetchMock): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = mock as unknown as typeof fetch; // test seam: replace the global fetch
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function session(overrides: Partial<AutoSession> = {}): AutoSession {
  return {
    selectedModelID: "gpt-5.4",
    sessionToken: "sess-tok",
    availableModels: ["gpt-5.4", "claude-sonnet-4-6", "claude-opus-4-6"],
    discountedCosts: {},
    expiresAtMs: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

function conv(overrides: Partial<ConvState> = {}): ConvState {
  return { turn: 0, ...overrides };
}

function router(
  descriptor: EndpointDescriptor,
  catalog: ReadonlyMap<string, EndpointDescriptor> = CATALOG,
): IntentRouter {
  return new IntentRouter(new CapiClient(silentLogger), silentLogger, descriptor, {}, catalog);
}

test("matchesEndpoint resolves pool ids through catalog metadata, never cross-family", () => {
  const responses = router(RESPONSES_ANCHOR);
  assert.equal(responses.matchesEndpoint("mai-code-1.1-flash"), true, "catalog: responses model");
  assert.equal(responses.matchesEndpoint("gpt-5.4"), true, "catalog: responses model");
  assert.equal(responses.matchesEndpoint("grok-4.5"), false, "responses but other host — different endpoint");
  assert.equal(responses.matchesEndpoint("gemini-3.1-pro-preview"), false, "chat-completions model");
  assert.equal(responses.matchesEndpoint("claude-sonnet-4-6"), false, "anthropic model");

  const completions = router(COMPLETIONS_ANCHOR);
  assert.equal(completions.matchesEndpoint("gemini-3.1-pro-preview"), true);
  assert.equal(completions.matchesEndpoint("gpt-4.1"), true);
  assert.equal(completions.matchesEndpoint("mai-code-1.1-flash"), false, "responses model never routed to chat-completions");

  const anthropic = router(ANTHROPIC_ANCHOR);
  assert.equal(anthropic.matchesEndpoint("claude-sonnet-4-6"), true, "catalog root baseUrl equals /v1 anchor");
  assert.equal(anthropic.matchesEndpoint("gpt-5.4"), false);
});

test("heuristic classifies ids absent from the catalog; unknown ids stay ineligible", () => {
  const responses = router(RESPONSES_ANCHOR, new Map()); // no catalog metadata at all
  assert.equal(responses.matchesEndpoint("mai-code-1.1-flash"), true, "mai → openai-responses heuristic");
  assert.equal(responses.matchesEndpoint("gpt-5.4"), true, "gpt → openai-responses heuristic");
  assert.equal(responses.matchesEndpoint("gemini-3.1-pro-preview"), false, "gemini → openai-completions");
  assert.equal(responses.matchesEndpoint("claude-sonnet-4-6"), false, "claude → anthropic-messages");
  assert.equal(responses.matchesEndpoint("grok-4.5"), false, "unknown family — never eligible");

  const completions = router(COMPLETIONS_ANCHOR, new Map());
  assert.equal(completions.matchesEndpoint("gemini-3.1-pro-preview"), true);
  assert.equal(completions.matchesEndpoint("gpt-5.4"), false);
});

test("defaultPoolModel picks the first same-endpoint pool entry", () => {
  const s = session({ availableModels: ["mai-code-1.1-flash", "gemini-3.1-pro-preview", "gpt-5.4"] });
  assert.equal(router(RESPONSES_ANCHOR).defaultPoolModel(s), "mai-code-1.1-flash");
  assert.equal(router(COMPLETIONS_ANCHOR).defaultPoolModel(s), "gemini-3.1-pro-preview");
  assert.equal(router(ANTHROPIC_ANCHOR).defaultPoolModel(s), undefined, "no claude in this pool");
  assert.equal(router(RESPONSES_ANCHOR).defaultPoolModel(undefined), undefined);
});

test("decideTurn reuses the committed route (sticky) without calling the intent endpoint", async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls += 1;
    throw new Error("must not fetch on the sticky path");
  });
  try {
    const c = conv({
      session: session(),
      routedModelID: "gpt-5.4",
      routedLabel: "needs_reasoning",
      routedConfidence: 0.9,
      turn: 3,
    });
    const verdict = await router(RESPONSES_ANCHOR).decideTurn({
      conv: c,
      sessionId: "s1",
      baseURL: BASE,
      bearer: "b",
      prompt: "hi",
    });
    assert.equal(fetchCalls, 0);
    assert.equal(verdict.decided, "gpt-5.4");
    assert.equal(verdict.label, "needs_reasoning");
    assert.equal(verdict.confidence, 0.9);
    assert.equal(verdict.source, "sticky");
    assert.equal(verdict.omitSessionToken, false);
  } finally {
    restore();
  }
});

test("sticky route outside the pool sets omitSessionToken", async () => {
  const restore = withFetch(async () => {
    throw new Error("must not fetch on the sticky path");
  });
  try {
    const c = conv({ session: session(), routedModelID: "grok-4.5", turn: 2 });
    const verdict = await router(RESPONSES_ANCHOR).decideTurn({
      conv: c,
      sessionId: "s1",
      baseURL: BASE,
      bearer: "b",
      prompt: "hi",
    });
    assert.equal(verdict.decided, "grok-4.5");
    assert.equal(verdict.source, "sticky");
    assert.equal(verdict.omitSessionToken, true);
  } finally {
    restore();
  }
});

test("turn-0 decideTurn filters candidates to the anchor endpoint (responses vs chat-completions)", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const restore = withFetch(async (input, init) => {
    captured = { url: String(input), init: init ?? {} };
    return jsonResponse({
      predicted_label: "needs_reasoning",
      confidence: 0.87,
      candidate_models: [
        "gemini-3.1-pro-preview", // openai-completions — must be dropped
        "claude-opus-4-6",        // anthropic — must be dropped
        "mai-code-1.1-flash",     // openai-responses @ individual — eligible
        "gpt-5.4-codex",          // openai-responses @ individual — eligible
      ],
    });
  });
  try {
    const pool = session({
      selectedModelID: "mai-code-1.1-flash",
      availableModels: ["mai-code-1.1-flash", "gpt-5.4-codex", "gemini-3.1-pro-preview"],
    });
    const c = conv({ session: pool, lastPrompt: "analyze this" });
    const verdict = await router(RESPONSES_ANCHOR).decideTurn({
      conv: c,
      sessionId: "s1",
      baseURL: BASE,
      bearer: "b",
      prompt: "analyze this",
    });

    assert.ok(captured, "intent endpoint must be called on turn 0");
    assert.equal(captured.url, `${BASE}/models/session/intent`);
    const body = JSON.parse(String(captured.init.body)) as Record<string, unknown>;
    assert.equal(body.prompt, "analyze this");
    assert.equal(body.turn_number, 1);
    assert.equal(body.session_id, "s1");

    assert.equal(verdict.decided, "mai-code-1.1-flash", "first eligible candidate of the anchor endpoint");
    assert.equal(verdict.label, "needs_reasoning");
    assert.equal(verdict.confidence, 0.87);
    assert.equal(verdict.source, "intent");
    assert.equal(verdict.omitSessionToken, false);
  } finally {
    restore();
  }
});

test("intent with no same-endpoint candidates falls back to the endpoint pool default", async () => {
  // The intent endpoint proposes only responses-family ids; the
  // completions anchor drops them all and keeps its pool default.
  const restore = withFetch(async () => jsonResponse({ candidate_models: ["mai-code-1.1-flash"] }));
  try {
    const pool = session({
      selectedModelID: "gemini-3.1-pro-preview",
      availableModels: ["gemini-3.1-pro-preview", "mai-code-1.1-flash"],
    });
    const c = conv({ session: pool, lastPrompt: "hi" });
    const verdict = await router(COMPLETIONS_ANCHOR).decideTurn({
      conv: c,
      sessionId: "s1",
      baseURL: BASE,
      bearer: "b",
      prompt: "hi",
    });
    assert.equal(verdict.decided, "gemini-3.1-pro-preview");
    assert.equal(verdict.source, "fallback");
  } finally {
    restore();
  }
});

test("fallback is endpoint-clamped even without a session", async () => {
  const restore = withFetch(async () => jsonResponse({}));
  try {
    const anthropicVerdict = await router(ANTHROPIC_ANCHOR).decideTurn({
      conv: conv(),
      sessionId: "s1",
      baseURL: BASE,
      bearer: undefined,
      prompt: undefined,
    });
    assert.equal(anthropicVerdict.decided, "claude-sonnet-4-6");
    assert.equal(anthropicVerdict.source, "fallback");
    assert.equal(anthropicVerdict.omitSessionToken, false); // no session → nothing to omit

    const responsesVerdict = await router(RESPONSES_ANCHOR).decideTurn({
      conv: conv(),
      sessionId: "s1",
      baseURL: BASE,
      bearer: undefined,
      prompt: undefined,
    });
    assert.equal(responsesVerdict.decided, "gpt-5.4", "responses anchor falls back to a responses wire id");
  } finally {
    restore();
  }
});

test("selectedModelID is only honored when its endpoint matches the anchor", async () => {
  const restore = withFetch(async () => jsonResponse({}));
  try {
    // Server picked a chat-completions model but the router is anchored
    // to responses: clamp to the responses fallback; outside the pool →
    // omit the token.
    const c = conv({ session: session({ availableModels: ["gemini-3.1-pro-preview"], selectedModelID: "gemini-3.1-pro-preview" }) });
    const verdict = await router(RESPONSES_ANCHOR).decideTurn({
      conv: c,
      sessionId: "s1",
      baseURL: BASE,
      bearer: "b",
      prompt: "hi",
    });
    assert.equal(verdict.decided, "gpt-5.4");
    assert.equal(verdict.omitSessionToken, true);
  } finally {
    restore();
  }
});

test("applyReasoningBoost shapes reasoning per anchor API and never lowers effort", () => {
  // anthropic-messages → thinking budget
  const anthropic = router(ANTHROPIC_ANCHOR);
  const claudePayload: WirePayload = { model: "claude-sonnet-4-6" };
  anthropic.applyReasoningBoost(claudePayload, "claude-sonnet-4-6", "needs_reasoning");
  assert.deepEqual(claudePayload.thinking, { type: "enabled", budget_tokens: 16_000 });

  // openai-completions → reasoning_effort
  const completions = router(COMPLETIONS_ANCHOR);
  const gptPayload: WirePayload = { model: "gemini-3.1-pro-preview" };
  completions.applyReasoningBoost(gptPayload, "gemini-3.1-pro-preview", "needs_reasoning");
  assert.equal(gptPayload.reasoning_effort, "high");

  // openai-responses → reasoning { effort, summary }
  const responses = router(RESPONSES_ANCHOR);
  const maiPayload: WirePayload = { model: "mai-code-1.1-flash" };
  responses.applyReasoningBoost(maiPayload, "mai-code-1.1-flash", "needs_reasoning");
  assert.deepEqual(maiPayload.reasoning, { effort: "high", summary: "auto" });
  assert.equal(maiPayload.reasoning_effort, undefined, "no stale chat-completions effort on a responses body");

  // Existing reasoning fields are preserved; the stale effort flag is dropped.
  const withReasoning: WirePayload = { model: "gpt-5.4", reasoning: { effort: "medium", include: ["reasoning.encrypted_content"] } };
  responses.applyReasoningBoost(withReasoning, "gpt-5.4", "needs_reasoning");
  assert.deepEqual(withReasoning.reasoning, {
    effort: "high",
    summary: "auto",
    include: ["reasoning.encrypted_content"],
  });

  // Fast turns are never boosted.
  const untouched: WirePayload = { model: "gpt-5.4" };
  responses.applyReasoningBoost(untouched, "gpt-5.4", "no_reasoning");
  assert.equal(untouched.reasoning, undefined);
  assert.equal(untouched.reasoning_effort, undefined);
  assert.equal(untouched.thinking, undefined);
});

test("anthropicBudgetTokens option overrides the boost budget", () => {
  const withBudget = new IntentRouter(new CapiClient(silentLogger), silentLogger, ANTHROPIC_ANCHOR, {
    anthropicBudgetTokens: 8_000,
  });
  const p: WirePayload = { model: "m" };
  withBudget.applyReasoningBoost(p, "m", "needs_reasoning");
  assert.deepEqual(p.thinking, { type: "enabled", budget_tokens: 8_000 });
});
