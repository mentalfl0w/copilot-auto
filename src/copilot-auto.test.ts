/**
 * copilot-auto — CopilotAuto orchestrator tests.
 *
 * Drives the extension through a fake ExtensionAPI: session_start
 * registration, per-turn routing, and the fetch-patch token queue.
 * Verifies:
 *   - the probe session only seeds the session it was minted for
 *     (Copilot-Session-Token is conversation-scoped);
 *   - concurrent sessions routing the same wire model each get their own
 *     token (FIFO pending-token queue, never a scan of conv state);
 *   - non-auto payloads pass through unmutated;
 *   - the Claude-anchored registration carries disableStrictTools in the
 *     PROVIDER compat (the host's registerProvider forwards provider-level
 *     compat into the model builder; model-entry flags are ignored), while
 *     the GPT anchor keeps its per-model compat flags.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CopilotAuto } from "./copilot-auto.ts";
import { AUTO_MODEL_ID } from "./provider-registrar.ts";
import type { CopilotCatalogModel, ExtensionAPI, ExtensionCtx, ProviderModelEntry, WirePayload } from "./types.ts";

const BASE = "https://api.githubcopilot.com";
const INDIVIDUAL = "https://api.individual.githubcopilot.com";
const CHAT_URL = `${BASE}/chat/completions`;

/** Live-catalog endpoint metadata (models.db github-copilot cache). */
const CATALOG: CopilotCatalogModel[] = [
  { provider: "github-copilot", id: "mai-code-1.1-flash", api: "openai-responses", baseUrl: INDIVIDUAL },
  { provider: "github-copilot", id: "gpt-5.4", api: "openai-responses", baseUrl: INDIVIDUAL },
  { provider: "github-copilot", id: "gpt-5.4-codex", api: "openai-responses", baseUrl: INDIVIDUAL },
  { provider: "github-copilot", id: "gemini-3.1-pro-preview", api: "openai-completions", baseUrl: INDIVIDUAL },
  { provider: "github-copilot", id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: BASE },
];

type Handler = (event: unknown, ctx: ExtensionCtx) => unknown;

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler>;
  registrations: Array<{
    providerId: string;
    models?: ProviderModelEntry[];
    compat?: Record<string, unknown>;
    apiKey?: string;
    oauth?: { name?: string };
  }>;
}

/** OMP-shaped fake: the host injects a truthy `pi` self-reference. */
function fakePiOmp(): FakePi {
  return fakePiFor({ pi: {} });
}

/** Pi-shaped fake: Pi does NOT inject the self-reference (pi undefined). */
function fakePiPi(): FakePi {
  return fakePiFor({ pi: undefined });
}

function fakePiFor(shape: { pi?: unknown }): FakePi {
  const handlers = new Map<string, Handler>();
  const registrations: FakePi["registrations"] = [];
  const pi: ExtensionAPI = {
    pi: shape.pi,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
    registerProvider: (providerId, config) => {
      registrations.push({ providerId, models: config.models, compat: config.compat, apiKey: config.apiKey, oauth: config.oauth });
    },
  };
  return { pi, handlers, registrations };
}

function ctxFor(sessionId: string, models: CopilotCatalogModel[] = CATALOG): ExtensionCtx {
  return {
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: { getApiKeyForProvider: async () => "bearer-1" },
    models: { list: () => models },
    ui: { setStatus: () => {}, notify: () => {} },
  };
}

async function fire(
  handlers: Map<string, Handler>,
  event: string,
  payload: unknown,
  ctx: ExtensionCtx,
): Promise<unknown> {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler registered for ${event}`);
  return await handler(payload, ctx);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function harness() {
  let sessionOpens = 0;
  const chatTokens: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models/session")) {
      sessionOpens += 1;
      return jsonResponse({
        session_token: sessionOpens === 1 ? "probe-tok" : `own-tok-${sessionOpens}`,
        selected_model: "claude-sonnet-4-6",
        available_models: ["claude-sonnet-4-6", "claude-opus-4-6"],
      });
    }
    if (url.includes("/chat/completions")) {
      chatTokens.push(new Headers(init?.headers).get("Copilot-Session-Token") ?? "");
      return jsonResponse({});
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    sessionOpens: () => sessionOpens,
    chatTokens: () => chatTokens,
  };
}

test("probe seed is scoped to its session; same-model turns get their own tokens", async () => {
  const mock = harness();
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();

    // Registration on session A: the probe seeds A only.
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    // Turn A routes to the family default and queues A's (probe) token.
    const payloadA: WirePayload = { model: "auto" };
    const resultA = await fire(handlers, "before_provider_request", { payload: payloadA }, ctxFor("sess-A"));
    assert.equal(resultA, payloadA, "routed payload must be returned");
    assert.equal(payloadA.model, "claude-sonnet-4-6");
    assert.equal(mock.sessionOpens(), 1, "sess-A must serve the probe seed, not open its own");

    // Branch session B must open its own session — never reuse the probe token.
    const payloadB: WirePayload = { model: "auto" };
    const resultB = await fire(handlers, "before_provider_request", { payload: payloadB }, ctxFor("sess-B"));
    assert.equal(resultB, payloadB);
    assert.equal(payloadB.model, "claude-sonnet-4-6");
    assert.equal(mock.sessionOpens(), 2, "sess-B must open its own session (conversation-scoped token)");

    // Same wire model from both sessions: each outgoing request consumes
    // exactly its own turn's token (FIFO per model).
    await fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) });
    await fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) });
    assert.deepEqual(mock.chatTokens(), ["probe-tok", "own-tok-2"]);
  } finally {
    mock.restore();
  }
});

test("non-auto payloads pass through unmutated", async () => {
  const mock = harness();
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    const payload: WirePayload = { model: "claude-sonnet-4-6", thinking: { type: "enabled", budget_tokens: 1000 } };
    const result = await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-A"));
    assert.equal(result, undefined, "non-auto requests are left to the host");
    assert.equal(payload.model, "claude-sonnet-4-6");
    assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 1000 });
  } finally {
    mock.restore();
  }
});
test("reasoning_bucket overrides a contradictory label in fallback routing", async () => {
  const original = globalThis.fetch;
  const interactionIds: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    interactionIds.push(new Headers(init?.headers).get("X-Interaction-Id") ?? "");
    if (url.endsWith("/models/session")) {
      return jsonResponse({
        session_token: "reasoning-session",
        selected_model: "claude-sonnet-4-6",
        available_models: ["claude-sonnet-4-6"],
      });
    }
    if (url.endsWith("/models/session/intent")) {
      return jsonResponse({
        predicted_label: "no_reasoning",
        reasoning_bucket: "low",
        candidate_models: ["claude-sonnet-4-6"],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    const ctx = ctxFor("sess-reasoning");
    await fire(handlers, "session_start", undefined, ctx);
    await fire(handlers, "input", { text: "explain this change" }, ctx);

    const payload: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload }, ctx);

    assert.equal(payload.model, "claude-sonnet-4-6");
    assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 4_000 });
    assert.equal(interactionIds.length, 2);
    assert.ok(interactionIds[0]);
    assert.equal(interactionIds[0], interactionIds[1]);
  } finally {
    globalThis.fetch = original;
  }
});


test("model is registered at factory load — resolvable BEFORE session_start (startup --model regression)", () => {
  // The host resolves the initial `--model github-copilot/auto` and the
  // session model scope during session creation, BEFORE session_start
  // fires; a registration deferred to session_start loses the startup
  // selection to `Model "github-copilot/auto" not found` (the observed
  // failure). The factory must register the shell model immediately.
  const { pi, registrations } = fakePiOmp();
  new CopilotAuto(pi).register();

  assert.equal(registrations.length, 1, "load-phase registration must exist before any event fires");
  const load = registrations[0];
  assert.equal(load.providerId, "github-copilot");
  assert.equal(load.apiKey, undefined, "no credential exists at load — resolution stays lazy via stored OAuth");
  assert.deepEqual(load.oauth, { name: "GitHub Copilot" }, "oauth marker satisfies the host's apiKey|oauth validation");
  assert.equal(load.models?.length, 1, "exactly one public model");
  assert.equal(load.models?.[0]?.id, AUTO_MODEL_ID);
  // Default responses anchor mirrors the probe-failure default (DESIGN
  // §9.4): the current Copilot GPT/MAI catalog is openai-responses on the
  // account-specific host — the old openai-completions default is what
  // sent mai-code-1.1-flash to /chat/completions (the reported 400).
  assert.equal(load.models?.[0]?.api, "openai-responses");
  assert.equal(load.models?.[0]?.baseUrl, INDIVIDUAL);
});

test("Pi-shaped API (pi undefined) registers the auto model WITHOUT the oauth marker", () => {
  // Pi does not inject the `pi` self-reference (omp-wechat convention).
  // Pi's registerProvider adapts a supplied `oauth` as a COMPLETE
  // ExtensionOAuthConfig (login/refreshToken/getApiKey functions
  // required), so the bare OMP marker would shadow the built-in GitHub
  // Copilot OAuth with a broken partial config. The credential-less load
  // registration must succeed with NO marker — Pi then inherits its
  // built-in `github-copilot` OAuth (load must never fail on missing
  // auth; issue #1 lesson).
  const { pi, registrations } = fakePiPi();
  new CopilotAuto(pi).register();

  assert.equal(registrations.length, 1, "load-phase registration must exist before any event fires");
  const load = registrations[0];
  assert.equal(load.providerId, "github-copilot");
  assert.equal(load.oauth, undefined, "Pi must not receive a partial oauth config — it inherits the built-in Copilot OAuth");
  assert.equal(load.apiKey, undefined, "no credential exists at load — resolution stays lazy via stored OAuth");
  assert.equal(load.models?.length, 1, "exactly one public model");
  assert.equal(load.models?.[0]?.id, AUTO_MODEL_ID);
});

test("registered Claude shell model carries disableStrictTools in provider compat", async () => {
  const mock = harness();
  try {
    const { pi, handlers, registrations } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    // Two registrations: the load-phase default (credential-less, GPT
    // anchor) at factory time, then the session_start re-anchor which
    // wholesale-replaces it. The LAST registration is the live one.
    assert.equal(registrations.length, 2);
    const registration = registrations[1];
    assert.equal(registration.providerId, "github-copilot");
    // The host's registerProvider forwards PROVIDER-level `compat` into
    // the model builder (sOe(..., t.compat, ..., model)); a model-entry
    // disableStrictTools flag would be silently ignored.
    assert.deepEqual(registration.compat, { disableStrictTools: true });
    assert.equal(registration.models?.length, 1);
    const shell = registration.models?.[0];
    assert.ok(shell);
    assert.equal(shell.id, AUTO_MODEL_ID);
    assert.equal(shell.api, "anthropic-messages");
    assert.equal(shell.compat?.disableStrictTools, undefined, "no host-ignored model-entry flag");
  } finally {
    mock.restore();
  }
});

test("responses-anchored registration uses the account-specific responses endpoint", async () => {
  // Real-account regression: the GPT/MAI pool is openai-responses on the
  // individual host — the shell model must anchor there, never to
  // chat-completions (the reported mai-code-1.1-flash 400).
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/models/session")) {
      return jsonResponse({
        session_token: "gpt-probe",
        selected_model: "gpt-5.4",
        available_models: ["gpt-5.4", "gpt-5.4-codex"],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  try {
    const { pi, handlers, registrations } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    assert.equal(registrations.length, 2);
    const registration = registrations[1];
    assert.equal(registration.compat, undefined, "no provider-level disableStrictTools on the responses anchor");
    assert.equal(registration.models?.length, 1);
    const shell = registration.models?.[0];
    assert.ok(shell);
    assert.equal(shell.id, AUTO_MODEL_ID);
    assert.equal(shell.api, "openai-responses");
    assert.equal(shell.baseUrl, INDIVIDUAL, "account-specific baseUrl from the catalog metadata");
    assert.equal(shell.compat, undefined, "catalog responses models carry no compat overrides");
  } finally {
    globalThis.fetch = original;
  }
});

test("concurrent same-model turns never cross-stamp session tokens", async () => {
  const mock = harness();
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    // Two sessions route the same wire model concurrently (agent +
    // subagent). Each turn queues its own conversation's token for the
    // fetch patch; the patch consumes FIFO per wire model at send-time.
    const payloadA: WirePayload = { model: "auto" };
    const payloadB: WirePayload = { model: "auto" };
    const [resultA, resultB] = await Promise.all([
      fire(handlers, "before_provider_request", { payload: payloadA }, ctxFor("sess-A")),
      fire(handlers, "before_provider_request", { payload: payloadB }, ctxFor("sess-B")),
    ]);
    assert.equal(resultA, payloadA);
    assert.equal(resultB, payloadB);
    assert.equal(payloadA.model, "claude-sonnet-4-6");
    assert.equal(payloadB.model, "claude-sonnet-4-6");
    assert.equal(mock.sessionOpens(), 2, "sess-B opens its own session, never the probe's");

    // Two concurrent chat POSTs for the same wire model: each consumes
    // exactly one queued token — both sessions represented, never the
    // other session's token, never duplicated.
    await Promise.all([
      fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) }),
      fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) }),
    ]);
    const tokens = mock.chatTokens();
    assert.equal(tokens.length, 2);
    assert.equal(new Set(tokens).size, 2, "both tokens distinct — no cross-session reuse");
    assert.deepEqual(new Set(tokens), new Set(["probe-tok", "own-tok-2"]));
  } finally {
    mock.restore();
  }
});

test("session_shutdown restores the patch and clears the queue; the next session_start recaptures the current fetch", async () => {
  const mock1 = harness();
  // A second wrapper the host installs BETWEEN sessions (new core
  // middleware): traffic must flow through it, never the stale one.
  const h2Seen: string[] = [];
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();

    // Session 1: install over H1, register, route one turn (queues a token).
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));
    const payload: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-A"));
    assert.equal(payload.model, "claude-sonnet-4-6");
    assert.equal(mock1.chatTokens().length, 0, "queued token not yet consumed");

    // Teardown: patch restored, queued tokens dropped.
    await fire(handlers, "session_shutdown", undefined, ctxFor("sess-A"));
    await fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) });
    assert.deepEqual(mock1.chatTokens(), [""], "patch restored: chat POST after shutdown goes unstamped");

    // The host re-wraps fetch before the next session.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models/session")) {
        return jsonResponse({
          session_token: "fresh-session-2",
          selected_model: "claude-sonnet-4-6",
          available_models: ["claude-sonnet-4-6"],
        });
      }
      if (url.includes("/chat/")) {
        h2Seen.push(new Headers(init?.headers).get("Copilot-Session-Token") ?? "");
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Session 2: install must capture the CURRENT wrapper (H2), not the
    // one captured before shutdown.
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));
    // No routing since shutdown: the pre-shutdown token must not be queued
    // anymore, so a send goes unstamped (queue was cleared at shutdown).
    await fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) });
    assert.deepEqual(h2Seen, [""], "no pre-shutdown token leaks into the next session");

    // Routing in session 2 queues a fresh token and stamps through H2.
    const payload2: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload: payload2 }, ctxFor("sess-A"));
    await fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) });
    assert.deepEqual(h2Seen, ["", "fresh-session-2"]);
    assert.equal(mock1.chatTokens().length, 1, "session-2 traffic never reached the stale H1");
  } finally {
    mock1.restore();
  }
});
test("compaction drops the compacted session's queued tokens, preserving siblings'", async () => {
  const mock = harness();
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    // Both sessions route the same wire model; each queues its own token.
    const payloadA: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload: payloadA }, ctxFor("sess-A"));
    const payloadB: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload: payloadB }, ctxFor("sess-B"));
    assert.equal(mock.sessionOpens(), 2);

    // Compacting sess-A drops ONLY sess-A's queued token.
    await fire(handlers, "session_before_compact", { sessionId: "sess-A" }, ctxFor("sess-A"));

    // The next request for the wire model consumes B's token — never A's
    // pre-compaction token.
    await fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) });
    assert.deepEqual(mock.chatTokens(), ["own-tok-2"]);
    // Nothing left queued: the next request fails closed (unstamped).
    await fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) });
    assert.deepEqual(mock.chatTokens(), ["own-tok-2", ""]);
  } finally {
    mock.restore();
  }
});

test("compaction drops retry leases: a pre-compaction retry never re-stamps post-compaction", async () => {
  const original = globalThis.fetch;
  const seenTokens: string[] = [];
  let statuses = [429, 200];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models/session")) {
      return jsonResponse({
        session_token: "probe-tok",
        selected_model: "claude-sonnet-4-6",
        available_models: ["claude-sonnet-4-6", "claude-opus-4-6"],
      });
    }
    if (url.includes("/chat/completions")) {
      seenTokens.push(new Headers(init?.headers).get("Copilot-Session-Token") ?? "");
      return jsonResponse({}, statuses.shift() ?? 200);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));
    const payload: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-A"));

    const body = JSON.stringify({ model: "claude-sonnet-4-6" });
    // First attempt: 429 → the token stays leased to this request.
    await fetch(CHAT_URL, { method: "POST", body });
    assert.deepEqual(seenTokens, ["probe-tok"]);

    // Compaction between the 429 and the retry clears the lease.
    await fire(handlers, "session_before_compact", { sessionId: "sess-A" }, ctxFor("sess-A"));
    // The retry re-enters the patch with no lease and no queued token:
    // fail closed (unstamped) instead of stamping a pre-compaction token.
    await fetch(CHAT_URL, { method: "POST", body });
    assert.deepEqual(seenTokens, ["probe-tok", ""]);
  } finally {
    globalThis.fetch = original;
  }
});

// ── endpoint-aware anchoring (mai-code-1.1-flash regression) ─────────

/** Real-account pool: mai (responses@individual) selected, with a larger
 *  chat-completions group (gemini) — the selected_model's endpoint must
 *  win the anchor, never the largest pool group. */
function maiHarness(): {
  restore: () => void;
  chatTokens: () => string[];
} {
  const chatTokens: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models/session")) {
      return jsonResponse({
        session_token: "mai-probe",
        selected_model: "mai-code-1.1-flash",
        available_models: [
          "mai-code-1.1-flash",
          "gemini-3.1-pro-preview",
          "gemini-3.5-flash",
          "gemini-3.6-flash",
        ],
      });
    }
    if (url.endsWith("/models/session/intent")) {
      return jsonResponse({
        predicted_label: "needs_reasoning",
        confidence: 0.9,
        candidate_models: ["mai-code-1.1-flash", "gemini-3.1-pro-preview"],
      });
    }
    if (url.includes("/chat/completions") || url.includes("/responses")) {
      chatTokens.push(new Headers(init?.headers).get("Copilot-Session-Token") ?? "");
      return jsonResponse({});
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    chatTokens: () => chatTokens,
  };
}

test("mai pool + catalog metadata anchors openai-responses on the account-specific baseUrl and routes mai", async () => {
  const mock = maiHarness();
  try {
    const { pi, handlers, registrations } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    // Anchor: selected mai-code-1.1-flash → openai-responses @ individual,
    // even though the gemini chat-completions group is larger.
    assert.equal(registrations.length, 2);
    const registration = registrations[1];
    assert.equal(registration.compat, undefined, "no provider disableStrictTools on the responses anchor");
    assert.equal(registration.models?.[0]?.api, "openai-responses");
    assert.equal(registration.models?.[0]?.baseUrl, INDIVIDUAL, "account-specific baseUrl must be preserved");

    // A turn routes to the responses wire id and boosts the responses
    // reasoning shape — never reasoning_effort (chat-completions shape).
    await fire(handlers, "input", { text: "analyze this", images: [] }, ctxFor("sess-A"));
    const payload: WirePayload = { model: "auto" };
    const result = await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-A"));
    assert.equal(result, payload);
    assert.equal(payload.model, "mai-code-1.1-flash");
    assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
    assert.equal(payload.reasoning_effort, undefined, "no stale chat-completions effort field");

    // The queued token flows to the responses chat endpoint.
    await fetch(`${INDIVIDUAL}/responses`, { method: "POST", body: JSON.stringify({ model: "mai-code-1.1-flash" }) });
    assert.deepEqual(mock.chatTokens(), ["mai-probe"]);
  } finally {
    mock.restore();
  }
});

test("anchor prefers the server selected_model's endpoint over the largest pool group", async () => {
  const mock = maiHarness();
  try {
    const { pi, handlers, registrations } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    const shell = registrations[1].models?.[0];
    assert.ok(shell);
    assert.equal(shell.api, "openai-responses", "selected mai is responses — anchor follows, not the 3-gemini group");
    assert.equal(shell.baseUrl, INDIVIDUAL);
  } finally {
    mock.restore();
  }
});

// ── RPC prompt capture (before_agent_start) ──────────────────────────

/** Records every intent request body: asserts WHICH prompt the router
 *  actually sent, not just that some routing happened. */
function promptHarness(): {
  restore: () => void;
  intentBodies: () => Array<{ prompt?: string; reference_count?: number; session_id?: string }>;
} {
  const intentBodies: Array<{ prompt?: string; reference_count?: number; session_id?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models/session")) {
      return jsonResponse({
        session_token: "mai-probe",
        selected_model: "mai-code-1.1-flash",
        available_models: ["mai-code-1.1-flash", "gemini-3.1-pro-preview"],
      });
    }
    if (url.endsWith("/models/session/intent")) {
      intentBodies.push(JSON.parse(String(init?.body ?? "{}")) as {
        prompt?: string;
        reference_count?: number;
        session_id?: string;
      });
      return jsonResponse({
        predicted_label: "needs_reasoning",
        confidence: 0.9,
        candidate_models: ["mai-code-1.1-flash"],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    intentBodies: () => intentBodies,
  };
}

test("before_agent_start captures the RPC prompt: intent fetch sees it and routes to the candidate", async () => {
  const mock = promptHarness();
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    // RPC turn: AgentSession.prompt() emits before_agent_start
    // { prompt, images, systemPrompt } — NEVER `input` (OMP 18
    // ExtensionRunner.emitBeforeAgentStart). The hook fires BEFORE the
    // same turn's before_provider_request.
    await fire(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "analyze this diff", images: [{ path: "a.png" }] },
      ctxFor("sess-A"),
    );

    const payload: WirePayload = { model: "auto" };
    const result = await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-A"));
    assert.equal(result, payload);
    assert.equal(payload.model, "mai-code-1.1-flash", "intent candidate must win the route");
    assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" }, "needs_reasoning boost applied");

    // The intent endpoint received the CAPTURED prompt text, image count
    // and the session id — the actual fix, not just an intent fetch.
    assert.equal(mock.intentBodies().length, 1, "intent fetch must run once for the turn");
    const body = mock.intentBodies()[0];
    assert.equal(body.prompt, "analyze this diff");
    assert.equal(body.reference_count, 1, "image count must reach the intent body");
    assert.equal(body.session_id, "sess-A");
  } finally {
    mock.restore();
  }
});

test("interactive `input` capture still feeds the intent router (RPC path must not regress it)", async () => {
  const mock = promptHarness();
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    // Interactive turn: the editor emits `input` before the agent start.
    await fire(
      handlers,
      "input",
      { type: "input", text: "review this PR", images: [], source: "interactive" },
      ctxFor("sess-A"),
    );

    const payload: WirePayload = { model: "auto" };
    const result = await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-A"));
    assert.equal(result, payload);
    assert.equal(payload.model, "mai-code-1.1-flash");
    assert.equal(mock.intentBodies().length, 1, "intent fetch must run for the interactive turn");
    assert.equal(mock.intentBodies()[0].prompt, "review this PR");
    assert.equal(mock.intentBodies()[0].reference_count, 0, "an empty images list resets the count to 0");
  } finally {
    mock.restore();
  }
});

test("an empty before_agent_start prompt never overwrites a captured prompt", async () => {
  const mock = promptHarness();
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-A"));

    await fire(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "real prompt", images: undefined },
      ctxFor("sess-A"),
    );
    // A follow-up event with no text (continuation / no user content)
    // must not clobber the captured prompt, and the absent images list
    // must preserve the prior reference count.
    await fire(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "   ", images: undefined },
      ctxFor("sess-A"),
    );

    const payload: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-A"));
    assert.equal(mock.intentBodies().length, 1, "intent fetch must still run with the surviving prompt");
    assert.equal(mock.intentBodies()[0].prompt, "real prompt");
    assert.equal(mock.intentBodies()[0].reference_count, undefined, "prior value preserved when images absent");
  } finally {
    mock.restore();
  }
});
test("plain auto routes through session/intent and never calls /auto", async () => {
  const autoCalls: string[] = [];
  const sessionCalls: string[] = [];
  const intentCalls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auto")) {
      autoCalls.push(JSON.stringify(init?.body));
      return jsonResponse({ error: "not found" }, 404);
    }
    if (url.endsWith("/models/session")) {
      sessionCalls.push(JSON.stringify(init?.body));
      return jsonResponse({
        session_token: "session-token",
        selected_model: "gpt-5.4",
        available_models: ["gpt-5.4", "gpt-5.3"],
      });
    }
    if (url.endsWith("/models/session/intent")) {
      intentCalls.push(JSON.stringify(init?.body));
      return jsonResponse({
        predicted_label: "needs_reasoning",
        confidence: 0.8,
        candidate_models: ["gpt-5.4", "gpt-5.3"],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  try {
    const { pi, handlers } = fakePiOmp();
    new CopilotAuto(pi).register();
    await fire(handlers, "session_start", undefined, ctxFor("sess-plain"));
    // Capture the prompt — intent routing requires it.
    await fire(
      handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "route this", images: [] },
      ctxFor("sess-plain"),
    );
    const payload: WirePayload = { model: "auto" };
    await fire(handlers, "before_provider_request", { payload }, ctxFor("sess-plain"));

    assert.equal(autoCalls.length, 0, "plain auto must never call /auto");
    assert.equal(sessionCalls.length >= 1, true, "plain auto must call /models/session");
    assert.equal(intentCalls.length >= 1, true, "plain auto must call /models/session/intent");
    assert.equal(payload.model, "gpt-5.4", "payload model should be routed to gpt-5.4");
  } finally {
    globalThis.fetch = original;
  }
});
