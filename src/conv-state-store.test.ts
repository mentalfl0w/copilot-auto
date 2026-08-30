/**
 * copilot-auto — ConvStateStore tests.
 *
 * Session lifecycle per DESIGN §7: lazy open, seeding from the catalog
 * probe, single-flight dedup of concurrent opens, refresh 60s before
 * expiry, stale-token tolerance on failed refresh, compaction
 * invalidation, scoped clearing, and route-generation checks.
 *
 * Lifecycle-safe route API: generation-based staleness detection,
 * scoped/global clear for shutdown and credential-disable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ConvStateStore, DEFAULT_REFRESH_SKEW_MS } from "./conv-state-store.ts";
import { CapiClient } from "./capi-client.ts";
import type { AutoSession, LoggerLike } from "./types.ts";

const silentLogger: LoggerLike = { log: () => undefined };
const BASE = "https://api.githubcopilot.com";

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
    availableModels: ["gpt-5.4"],
    discountedCosts: {},
    expiresAtMs: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

function makeStore(): ConvStateStore {
  return new ConvStateStore(new CapiClient(silentLogger), silentLogger);
}

test("default refresh skew matches the design's 60s", () => {
  assert.equal(DEFAULT_REFRESH_SKEW_MS, 60_000);
});

test("ensureSession serves the seeded session without opening its own", async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({ session_token: "own", selected_model: "m", available_models: ["m"] });
  });
  try {
    const store = makeStore();
    const seeded = session({ sessionToken: "seed-tok" });
    const got = await store.ensureSession("s1", "auto", BASE, "bearer", seeded);
    assert.equal(got, seeded);
    assert.equal(fetchCalls, 0);
    assert.equal(store.get("s1", "auto").session, seeded);
  } finally {
    restore();
  }
});

test("seed does not replace an existing session", async () => {
  const restore = withFetch(async () => {
    throw new Error("must not fetch");
  });
  try {
    const store = makeStore();
    const existing = session({ sessionToken: "existing" });
    store.get("s1", "auto").session = existing;
    const got = await store.ensureSession("s1", "auto", BASE, "bearer", session({ sessionToken: "seed" }));
    assert.equal(got, existing);
  } finally {
    restore();
  }
});

test("concurrent ensureSession calls share one in-flight session open", async () => {
  let fetchCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = withFetch(async () => {
    fetchCalls += 1;
    await gate;
    return jsonResponse({
      session_token: "tok",
      selected_model: "m",
      available_models: ["m"],
      expires_at: 1_900_000_000,
    });
  });
  try {
    const store = makeStore();
    const p1 = store.ensureSession("s1", "auto", BASE, "bearer");
    const p2 = store.ensureSession("s1", "auto", BASE, "bearer");
    assert.equal(fetchCalls, 1, "both callers must share one open");
    release();
    const [s1, s2] = await Promise.all([p1, p2]);
    assert.equal(fetchCalls, 1);
    assert.equal(s1, s2);
    assert.equal(s1?.sessionToken, "tok");
  } finally {
    restore();
  }
});

test("seed works even when a session open is already in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = withFetch(async () => {
    await gate;
    return jsonResponse({ session_token: "own", selected_model: "m", available_models: ["m"] });
  });
  try {
    const store = makeStore();
    const p1 = store.ensureSession("s1", "auto", BASE, "bearer");
    const seeded = session({ sessionToken: "seed" });
    const p2 = store.ensureSession("s1", "auto", BASE, "bearer", seeded);
    // The seed is assigned synchronously even while the open is pending.
    assert.equal(store.get("s1", "auto").session, seeded);
    release();
    const s1 = await p1;
    const s2 = await p2;
    assert.equal(s1?.sessionToken, "own"); // the in-flight open wins (fresher)
    assert.equal(s2?.sessionToken, "seed");
    assert.equal(store.get("s1", "auto").session?.sessionToken, "own");
  } finally {
    restore();
  }
});

test("ensureSession refreshes sessions inside the refresh skew", async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({ session_token: "fresh", selected_model: "m", available_models: ["m"] });
  });
  try {
    const store = makeStore();
    // 30s to expiry < 60s skew → refresh instead of serving.
    store.get("s1", "auto").session = session({ sessionToken: "stale", expiresAtMs: Date.now() + 30_000 });
    const got = await store.ensureSession("s1", "auto", BASE, "bearer");
    assert.equal(fetchCalls, 1);
    assert.equal(got?.sessionToken, "fresh");
  } finally {
    restore();
  }
});

test("failed refresh keeps serving the stale session (stale-token tolerance)", async () => {
  const restore = withFetch(async () => jsonResponse({ error: "boom" }, 500));
  try {
    const store = makeStore();
    const stale = session({ sessionToken: "stale", expiresAtMs: Date.now() + 30_000 });
    const conv = store.get("s1", "auto");
    conv.session = stale;
    const got = await store.ensureSession("s1", "auto", BASE, "bearer");
    assert.equal(got, stale);
    assert.equal(conv.session, stale);
  } finally {
    restore();
  }
});

test("ensureSession with no bearer serves the cached session without fetching", async () => {
  let fetchCalls = 0;
  const restore = withFetch(async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  });
  try {
    const store = makeStore();
    const s = session();
    store.get("s1", "auto").session = s;
    const got = await store.ensureSession("s1", "auto", BASE, undefined);
    assert.equal(got, s);
    assert.equal(fetchCalls, 0);
  } finally {
    restore();
  }
});

test("compaction invalidation targets one session and preserves commit state", () => {
  const store = makeStore();
  const a = store.get("s1", "auto");
  const b = store.get("s2", "auto");
  a.session = session();
  a.routedModelID = "gpt-5.4";
  a.routedLabel = "needs_reasoning";

  store.markNeedsReEval("s1");
  assert.equal(a.needsReEval, true);
  assert.equal(b.needsReEval, undefined);

  store.commitRouting(a, "gpt-5.4", "no_reasoning", false, 0.9);
  assert.equal(a.routedModelID, "gpt-5.4");
  assert.equal(a.routedLabel, "no_reasoning");
  assert.equal(a.routedConfidence, 0.9);
  assert.equal(a.omitSessionToken, false);
  assert.equal(a.previousModel, "gpt-5.4");
  assert.equal(a.needsReEval, false);
  assert.equal(a.turn, 1);

});

// ── lifecycle-safe route API tests ────────────────────────────────────

test("getRouteGeneration returns 0 for fresh conversation", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  assert.equal(store.getRouteGeneration(conv), 0);
});

test("getRouteGeneration returns current generation", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.generation = 3;
  assert.equal(store.getRouteGeneration(conv), 3);
});

test("isRouteCurrent returns true when conversation and generation match", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.generation = 2;
  assert.equal(store.isRouteCurrent("s1", "auto", conv, 2), true);
});

test("isRouteCurrent returns false when generation mismatches", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.generation = 3;
  assert.equal(store.isRouteCurrent("s1", "auto", conv, 2), false);
});

test("isRouteCurrent returns false when conversation removed from store", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.generation = 1;
  store.clear("s1");
  assert.equal(store.isRouteCurrent("s1", "auto", conv, 1), false);
});

test("isRouteCurrent returns false when conversation replaced with new object", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.generation = 1;
  // Simulate replacement: clear and re-get creates new ConvState
  store.clear("s1");
  const fresh = store.get("s1", "auto");
  fresh.generation = 1;
  assert.equal(store.isRouteCurrent("s1", "auto", conv, 1), false);
});

test("markNeedsReEval increments generation and clears in-flight session", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.sessionInflight = Promise.resolve(undefined);

  store.markNeedsReEval("s1");

  assert.equal(conv.needsReEval, true);
  assert.equal(conv.sessionInflight, undefined);
  assert.equal(conv.generation, 1);
});

test("markNeedsReEval on global scope increments all generations", () => {
  const store = makeStore();
  const a = store.get("s1", "auto");
  const b = store.get("s2", "auto");

  store.markNeedsReEval();

  assert.equal(a.generation, 1);
  assert.equal(b.generation, 1);
});

test("scoped clear removes all model entries for session", () => {
  const store = makeStore();
  const a = store.get("s1", "auto");
  const b = store.get("s1", "other-model");
  const c = store.get("s2", "auto");

  store.clear("s1");

  assert.equal(store.isRouteCurrent("s1", "auto", a, 0), false);
  assert.equal(store.isRouteCurrent("s1", "other-model", b, 0), false);
  assert.equal(store.isRouteCurrent("s2", "auto", c, 0), true);
});

test("global clear removes all conversations", () => {
  const store = makeStore();
  const a = store.get("s1", "auto");
  const b = store.get("s2", "auto");
  const c = store.get("s3", "other");

  store.clear();

  assert.equal(store.isRouteCurrent("s1", "auto", a, 0), false);
  assert.equal(store.isRouteCurrent("s2", "auto", b, 0), false);
  assert.equal(store.isRouteCurrent("s3", "other", c, 0), false);
});

test("scoped clear prevents late route from registering", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.generation = 0;

  store.clear("s1");
  const fresh = store.get("s1", "auto");
  fresh.generation = 0;

  // Old conv reference no longer in store
  assert.equal(store.isRouteCurrent("s1", "auto", conv, 0), false);
  // New conv is current
  assert.equal(store.isRouteCurrent("s1", "auto", fresh, 0), true);
});

test("global clear prevents all late route registrations", () => {
  const store = makeStore();
  const conv1 = store.get("s1", "auto");
  const conv2 = store.get("s2", "auto");
  conv1.generation = 0;
  conv2.generation = 0;

  store.clear();

  // Neither old reference is valid
  assert.equal(store.isRouteCurrent("s1", "auto", conv1, 0), false);
  assert.equal(store.isRouteCurrent("s2", "auto", conv2, 0), false);
});

test("clear does not affect conversations in other sessions when scoped", () => {
  const store = makeStore();
  const a = store.get("s1", "auto");
  const b = store.get("s2", "auto");
  a.generation = 1;
  b.generation = 1;

  store.clear("s1");

  assert.equal(store.isRouteCurrent("s2", "auto", b, 1), true);
});

test("no stale state retained after clear: session and generation all gone", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");
  conv.session = session();
  conv.generation = 5;

  store.clear("s1");

  // Conversation removed from the store; the old object cannot be current.
  assert.equal(store.isRouteCurrent("s1", "auto", conv, 5), false);
});

test("late session open cannot restore state after clear", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const restore = withFetch(async () => {
    await gate;
    return jsonResponse({
      session_token: "late-token",
      selected_model: "gpt-5.4",
      available_models: ["gpt-5.4"],
    });
  });
  try {
    const store = makeStore();
    const conv = store.get("s1", "auto");
    const opening = store.ensureSession("s1", "auto", BASE, "bearer");
    store.clear("s1");
    release();
    assert.equal(await opening, undefined);
    assert.equal(conv.session, undefined);
    assert.equal(conv.sessionInflight, undefined);
    assert.equal(store.isRouteCurrent("s1", "auto", conv, 0), false);
  } finally {
    restore();
  }
});

test("commitRouting after markNeedsReEval resets needsReEval and increments turn", () => {
  const store = makeStore();
  const conv = store.get("s1", "auto");

  store.markNeedsReEval("s1");
  assert.equal(conv.needsReEval, true);
  assert.equal(conv.generation, 1);

  store.commitRouting(conv, "gpt-5.4", "no_reasoning", false, 0.9);
  assert.equal(conv.needsReEval, false);
  assert.equal(conv.turn, 1);
  // Generation stays at 1 after commitRouting (only markNeedsReEval increments it)
  assert.equal(conv.generation, 1);
});
