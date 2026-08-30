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
import {
  CapiClient,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_INTEGRATION_ID,
  COPILOT_OPENAI_INTENT,
  COPILOT_USER_AGENT,
  DEFAULT_API_VERSION,
} from "./capi-client.ts";
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
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Authorization"), "Bearer bearer-1");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("X-GitHub-Api-Version"), DEFAULT_API_VERSION);
    assert.equal(headers.get("User-Agent"), COPILOT_USER_AGENT);
    assert.equal(headers.get("Editor-Version"), COPILOT_EDITOR_VERSION);
    assert.equal(headers.get("Editor-Plugin-Version"), COPILOT_EDITOR_PLUGIN_VERSION);
    assert.equal(headers.get("Copilot-Integration-Id"), COPILOT_INTEGRATION_ID);
    assert.equal(headers.get("Openai-Intent"), COPILOT_OPENAI_INTENT);
    assert.equal(headers.get("X-Initiator"), "user");
    const interactionId = headers.get("X-Interaction-Id");
    assert.match(interactionId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(interactionId, session?.interactionId);
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

test("unwraps OMP's structured Copilot credential before CAPI requests", async () => {
  let authorization: string | null = null;
  const restore = withFetch(async (_input, init) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return jsonResponse({
      session_token: "tok",
      selected_model: "gpt-5.4",
      available_models: ["gpt-5.4"],
    });
  });
  try {
    const credential = JSON.stringify({
      token: "copilot-access-token",
      apiEndpoint: BASE,
      expiresAt: Date.now() + 60_000,
    });
    await new CapiClient(silentLogger).fetchAutoSession(BASE, credential);
    assert.equal(authorization, "Bearer copilot-access-token");
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
test("Copilot Chat headers stay stable and interaction ids follow sessions", async () => {
  const seen: Array<Record<string, string>> = [];
  const restore = withFetch(async (_input, init) => {
    const h = new Headers(init?.headers);
    seen.push({
      userAgent: h.get("User-Agent") ?? "",
      editor: h.get("Editor-Version") ?? "",
      plugin: h.get("Editor-Plugin-Version") ?? "",
      integration: h.get("Copilot-Integration-Id") ?? "",
      intent: h.get("Openai-Intent") ?? "",
      initiator: h.get("X-Initiator") ?? "",
      interaction: h.get("X-Interaction-Id") ?? "",
    });
    return jsonResponse({ session_token: "t", selected_model: "m", available_models: ["m"] });
  });
  try {
    const client = new CapiClient(silentLogger);
    const first = await client.fetchAutoSession(BASE, "b");
    await client.getRouterDecision(BASE, "b", "t", "prompt", ["m"], {}, 100, first?.interactionId);
    const second = await client.fetchAutoSession(BASE, "b");
    assert.equal(seen.length, 3);

    for (const key of ["userAgent", "editor", "plugin", "integration", "intent", "initiator"]) {
      assert.equal(seen[0][key], seen[1][key]);
      assert.equal(seen[1][key], seen[2][key]);
    }
    assert.match(seen[0].interaction, /^[0-9a-f-]{36}$/);
    assert.equal(seen[0].interaction, first?.interactionId);
    assert.equal(seen[1].interaction, first?.interactionId);
    assert.equal(seen[2].interaction, second?.interactionId);
    assert.notEqual(seen[0].interaction, seen[2].interaction);
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

test("getRouterDecision stamps the session token and sends the Copilot Chat intent profile", async () => {
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
    const headers = new Headers(captured.init.headers);
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Authorization"), "Bearer bearer-1");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("X-GitHub-Api-Version"), DEFAULT_API_VERSION);
    assert.equal(headers.get("User-Agent"), COPILOT_USER_AGENT);
    assert.equal(headers.get("Editor-Version"), "vscode/1.107.0");
    assert.equal(headers.get("Editor-Plugin-Version"), "copilot-chat/0.35.0");
    assert.equal(headers.get("Copilot-Integration-Id"), "vscode-chat");
    assert.equal(headers.get("Openai-Intent"), "conversation-edits");
    assert.equal(headers.get("X-Initiator"), "user");
    assert.match(headers.get("X-Interaction-Id") ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(headers.get("Copilot-Session-Token"), "sess-tok");
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

test("getRouterDecision retains both session/intent response dialects", async () => {
  let call = 0;
  const restore = withFetch(async () => {
    call += 1;
    return call === 1
      ? jsonResponse({
          chosen_model: "gpt-5.4",
          reasoning_bucket: "high",
          candidate_models: ["gpt-5.4", "gpt-5.3"],
        })
      : jsonResponse({
          selected_model: "claude-sonnet-4-6",
          predicted_label: "no_reasoning",
          candidate_models: ["claude-sonnet-4-6"],
        });
  });
  try {
    const client = new CapiClient(silentLogger);
    const chosen = await client.getRouterDecision(BASE, "b", "t", "first", ["gpt-5.4"], {}, 100);
    assert.equal(chosen?.chosen_model, "gpt-5.4");
    assert.equal(chosen?.reasoning_bucket, "high");
    assert.deepEqual(chosen?.candidate_models, ["gpt-5.4", "gpt-5.3"]);

    const selected = await client.getRouterDecision(BASE, "b", "t", "second", ["claude-sonnet-4-6"], {}, 100);
    assert.equal(selected?.selected_model, "claude-sonnet-4-6");
    assert.equal(selected?.predicted_label, "no_reasoning");
    assert.deepEqual(selected?.candidate_models, ["claude-sonnet-4-6"]);
  } finally {
    restore();
  }
});

test("fetchAutoSession merges caller cancellation with the configured session timeout", async () => {
  let aborts = 0;
  const restore = withFetch(async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborts += 1;
        reject(new Error("aborted"));
      });
    }),
  );
  try {
    const client = new CapiClient(silentLogger, { sessionOpenTimeoutMs: 20 });
    assert.equal(await client.fetchAutoSession(BASE, "bearer"), undefined);
    assert.equal(aborts, 1);

    const caller = new AbortController();
    const pending = client.fetchAutoSession(BASE, "bearer", 1_000, caller.signal);
    caller.abort();
    assert.equal(await pending, undefined);
    assert.equal(aborts, 2);
  } finally {
    restore();
  }
});
