/**
 * copilot-auto — CapiClient tests.
 *
 * Mocks globalThis.fetch and asserts the wire contract from DESIGN §2.2:
 * header construction, request bodies, response parsing, and the intent
 * endpoint's hard-abort timeout. Tokens appear only in request headers,
 * never in logs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CapiClient, DEFAULT_API_VERSION, COPILOT_USER_AGENT } from "./capi-client.ts";
import type { LoggerLike } from "./types.ts";

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

test("fetchAutoSession sends copilot headers and the auto_mode body", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const restore = withFetch(async (input, init) => {
    captured = { url: String(input), init: init ?? {} };
    return jsonResponse({
      session_token: "tok-1",
      selected_model: "gpt-5.4",
      available_models: ["gpt-5.4", "claude-sonnet-4-6"],
      discounted_costs: { "gpt-5.4": 0.001 },
      expires_at: 1_800_000_000,
    });
  });
  try {
    const session = await new CapiClient(silentLogger).fetchAutoSession(BASE, "bearer-1");

    assert.ok(captured, "fetch must have been called");
    assert.equal(captured.url, `${BASE}/models/session`);
    const headers = new Headers(captured.init.headers);
    assert.equal(headers.get("Authorization"), "Bearer bearer-1");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("X-GitHub-Api-Version"), DEFAULT_API_VERSION);
    assert.equal(headers.get("User-Agent"), COPILOT_USER_AGENT);
    assert.match(headers.get("VScode-SessionId") ?? "", /^[0-9a-f-]{36}\d{13}$/);
    assert.match(headers.get("VScode-MachineId") ?? "", /^[0-9a-f]{32}$/);
    assert.match(headers.get("Editor-Device-Id") ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(headers.get("Copilot-Session-Token"), null);
    assert.deepEqual(JSON.parse(String(captured.init.body)), { auto_mode: { model_hints: ["auto"] } });

    assert.ok(session);
    assert.equal(session.sessionToken, "tok-1");
    assert.equal(session.selectedModelID, "gpt-5.4");
    assert.deepEqual(session.availableModels, ["gpt-5.4", "claude-sonnet-4-6"]);
    assert.deepEqual(session.discountedCosts, { "gpt-5.4": 0.001 });
    assert.equal(session.expiresAtMs, 1_800_000_000 * 1000);
  } finally {
    restore();
  }
});

test("fetchAutoSession defaults expires_at to now+30min", async () => {
  const before = Date.now();
  const restore = withFetch(async () =>
    jsonResponse({ session_token: "tok", selected_model: "m", available_models: ["m"] }),
  );
  try {
    const session = await new CapiClient(silentLogger).fetchAutoSession(BASE, "b");
    const after = Date.now();
    assert.ok(session);
    assert.ok(session.expiresAtMs >= before + 30 * 60_000, "expiry must be at least now+30min");
    assert.ok(session.expiresAtMs <= after + 30 * 60_000, "expiry must be computed from fetch time");
  } finally {
    restore();
  }
});

test("fetchAutoSession honors the apiVersion option", async () => {
  let capturedVersion: string | undefined;
  const restore = withFetch(async (_input, init) => {
    capturedVersion = new Headers(init?.headers).get("X-GitHub-Api-Version") ?? undefined;
    return jsonResponse({ session_token: "t", selected_model: "m", available_models: ["m"] });
  });
  try {
    await new CapiClient(silentLogger, { apiVersion: "2026-01-09" }).fetchAutoSession(BASE, "b");
    assert.equal(capturedVersion, "2026-01-09");
  } finally {
    restore();
  }
});
test("identity headers are per-process stable across session and intent calls", async () => {
  const seen: Array<Record<string, string>> = [];
  const restore = withFetch(async (_input, init) => {
    const h = new Headers(init?.headers);
    seen.push({
      session: h.get("VScode-SessionId") ?? "",
      machine: h.get("VScode-MachineId") ?? "",
      device: h.get("Editor-Device-Id") ?? "",
    });
    return jsonResponse({ session_token: "t", selected_model: "m", available_models: ["m"] });
  });
  try {
    const client = new CapiClient(silentLogger);
    await client.fetchAutoSession(BASE, "b");
    await client.getRouterDecision(BASE, "b", "t", "prompt", ["m"], {}, 100);
    await client.fetchAutoSession(BASE, "b");
    assert.equal(seen.length, 3);
    assert.equal(seen[0].session, seen[1].session, "VScode-SessionId must not change across session/intent calls");
    assert.equal(seen[0].machine, seen[1].machine, "VScode-MachineId must not change across session/intent calls");
    assert.equal(seen[0].device, seen[1].device, "Editor-Device-Id must not change across session/intent calls");
    assert.equal(seen[1].session, seen[2].session, "identities stay stable for the whole CapiClient lifetime");

    // A second CapiClient (another process) gets fresh identities.
    await new CapiClient(silentLogger).fetchAutoSession(BASE, "b");
    assert.equal(seen.length, 4);
    assert.notEqual(seen[3].session, seen[0].session);
    assert.notEqual(seen[3].machine, seen[0].machine);
    assert.notEqual(seen[3].device, seen[0].device);
  } finally {
    restore();
  }
});

test("fetchAutoSession degrades to undefined on non-ok, missing token, or garbage", async () => {
  const restore = withFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { auto_mode?: { model_hints?: string[] } };
    const hint = body.auto_mode?.model_hints?.[0];
    if (hint === "fail") return jsonResponse({ error: "boom" }, 500);
    if (hint === "garbage") return new Response("not json", { status: 200 });
    return jsonResponse({ selected_model: "m" }); // missing session_token
  });
  try {
    const client = new CapiClient(silentLogger);
    assert.equal(await client.fetchAutoSession(BASE, "b-fail"), undefined);
    assert.equal(await client.fetchAutoSession(BASE, "b-garbage"), undefined);
    assert.equal(await client.fetchAutoSession(BASE, "b"), undefined);
  } finally {
    restore();
  }
});

test("getRouterDecision stamps the session token and sends the intent body", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const restore = withFetch(async (input, init) => {
    captured = { url: String(input), init: init ?? {} };
    return jsonResponse({
      predicted_label: "needs_reasoning",
      confidence: 0.9,
      candidate_models: ["claude-opus-4-6", "gpt-5.4"],
    });
  });
  try {
    const decision = await new CapiClient(silentLogger).getRouterDecision(
      BASE,
      "bearer-1",
      "sess-tok",
      "explain this diff",
      ["gpt-5.4", "claude-opus-4-6"],
      { session_id: "s1", turn_number: 2, previous_model: "gpt-5.4", reference_count: 1, prompt_char_count: 17 },
      1_000,
    );

    assert.ok(captured);
    assert.equal(captured.url, `${BASE}/models/session/intent`);
    assert.equal(new Headers(captured.init.headers).get("Copilot-Session-Token"), "sess-tok");
    const body = JSON.parse(String(captured.init.body)) as Record<string, unknown>;
    assert.equal(body.prompt, "explain this diff");
    assert.deepEqual(body.available_models, ["gpt-5.4", "claude-opus-4-6"]);
    assert.equal(body.session_id, "s1");
    assert.equal(body.turn_number, 2);
    assert.equal(body.previous_model, "gpt-5.4");
    assert.equal(body.reference_count, 1);
    assert.equal(body.prompt_char_count, 17);

    assert.ok(decision);
    assert.equal(decision.predicted_label, "needs_reasoning");
    assert.equal(decision.confidence, 0.9);
    assert.deepEqual(decision.candidate_models, ["claude-opus-4-6", "gpt-5.4"]);
  } finally {
    restore();
  }
});

test("getRouterDecision hard-aborts at the intent timeout", async () => {
  const restore = withFetch(async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  try {
    const decision = await new CapiClient(silentLogger).getRouterDecision(
      BASE, "b", "t", "prompt", ["m"], {}, 20,
    );
    assert.equal(decision, undefined);
  } finally {
    restore();
  }
});

test("getRouterDecision degrades to undefined on non-ok and malformed payloads", async () => {
  const restore = withFetch(async (_input, init) => {
    const hint = String(init?.body).includes("404") ? "404" : "ok";
    if (hint === "404") return jsonResponse({ error: "x" }, 404);
    return new Response("not json", { status: 200 });
  });
  try {
    const client = new CapiClient(silentLogger);
    assert.equal(
      await client.getRouterDecision(BASE, "b", "t", "404", ["m"], {}, 100),
      undefined,
    );
    assert.equal(
      await client.getRouterDecision(BASE, "b", "t", "ok", ["m"], {}, 100),
      undefined,
    );
  } finally {
    restore();
  }
});
