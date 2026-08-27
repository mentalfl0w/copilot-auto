/**
 * copilot-auto — cross-runtime adapter tests.
 *
 * The compatibility layer that lets one bundled artifact run under both
 * OMP (truthy `pi` self-reference, apiKey|oauth validation, ctx.models)
 * and Pi (no self-reference, complete-oauth-config semantics,
 * modelRegistry.getAll / scopedModels):
 *   - runtimeKind discriminates the two hosts;
 *   - loadPhaseOAuth emits the marker for OMP only;
 *   - catalogModelEntries reads the host's catalog surface with the
 *     correct precedence;
 *   - resolveProviderCredential prefers getApiKeyForProvider and falls
 *     back to getProviderAuth (never logs the credential).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogModelEntries,
  loadPhaseOAuth,
  resolveProviderCredential,
  runtimeKind,
} from "./runtime-compat.ts";
import type { CopilotCatalogModel, ExtensionCtx } from "./types.ts";

const INDIVIDUAL = "https://api.individual.githubcopilot.com";
const BASE = "https://api.githubcopilot.com";

test("runtimeKind: truthy pi self-reference is OMP, absent/undefined is Pi", () => {
  assert.equal(runtimeKind({ pi: {} }), "omp", "OMP injects a truthy self-reference");
  assert.equal(runtimeKind({ pi: undefined }), "pi", "Pi does not inject one");
  assert.equal(runtimeKind({}), "pi", "absent key is Pi-shaped");
});

test("loadPhaseOAuth: marker for OMP, none for Pi (built-in OAuth inheritance)", () => {
  assert.deepEqual(loadPhaseOAuth("omp"), { name: "GitHub Copilot" });
  assert.equal(loadPhaseOAuth("pi"), undefined);
});

test("catalogModelEntries: ctx.models.list() wins; empty falls through to getAll", () => {
  const ctx: ExtensionCtx = {
    hasUI: true,
    ui: { setStatus: () => {} },
    modelRegistry: {
      getApiKeyForProvider: async () => "bearer",
      getAll: (): CopilotCatalogModel[] => [
        { provider: "github-copilot", id: "from-registry", api: "openai-responses", baseUrl: INDIVIDUAL },
      ],
    },
    models: {
      list: (): CopilotCatalogModel[] => [
        { provider: "github-copilot", id: "from-list", api: "openai-responses", baseUrl: INDIVIDUAL },
      ],
    },
  };
  const entries = catalogModelEntries(ctx);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "from-list", "the live registry view must win on OMP");
});

test("catalogModelEntries: getAll is the Pi catalog surface", () => {
  const ctx: ExtensionCtx = {
    hasUI: true,
    ui: { setStatus: () => {} },
    modelRegistry: {
      getApiKeyForProvider: async () => "bearer",
      getAll: (): CopilotCatalogModel[] => [
        { provider: "github-copilot", id: "mai-code-1.1-flash", api: "openai-responses", baseUrl: INDIVIDUAL },
        { provider: "github-copilot", id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: BASE },
      ],
    },
  };
  const entries = catalogModelEntries(ctx);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((m) => [m.provider, m.id, m.api, m.baseUrl]),
    [
      ["github-copilot", "mai-code-1.1-flash", "openai-responses", INDIVIDUAL],
      ["github-copilot", "claude-sonnet-4-6", "anthropic-messages", BASE],
    ],
    "provider/id/api/baseUrl metadata is preserved from getAll entries",
  );
});

test("catalogModelEntries: scopedModels is the last-resort Pi surface", () => {
  const ctx: ExtensionCtx = {
    hasUI: true,
    ui: { setStatus: () => {} },
    scopedModels: [
      { model: { provider: "github-copilot", id: "gpt-5.4", api: "openai-responses", baseUrl: INDIVIDUAL } },
    ],
  };
  const entries = catalogModelEntries(ctx);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "gpt-5.4");
});

test("catalogModelEntries: no surface yields an empty catalog", () => {
  const ctx: ExtensionCtx = { hasUI: true, ui: { setStatus: () => {} } };
  assert.deepEqual(catalogModelEntries(ctx), []);
});

test("resolveProviderCredential: prefers getApiKeyForProvider", async () => {
  const key = await resolveProviderCredential(
    { getApiKeyForProvider: async () => "bearer-1" },
    "github-copilot",
    "sess-1",
  );
  assert.equal(key, "bearer-1");
});

test("resolveProviderCredential: falls back to getProviderAuth when the primary is absent", async () => {
  const key = await resolveProviderCredential(
    {
      getProviderAuth: async () => ({ auth: { apiKey: "bearer-2" } }),
    },
    "github-copilot",
    undefined,
  );
  assert.equal(key, "bearer-2");
});

test("resolveProviderCredential: falls back when the primary throws", async () => {
  const key = await resolveProviderCredential(
    {
      getApiKeyForProvider: async () => {
        throw new Error("registry locked");
      },
      getProviderAuth: async () => ({ auth: { apiKey: "bearer-3" } }),
    },
    "github-copilot",
    undefined,
  );
  assert.equal(key, "bearer-3");
});

test("resolveProviderCredential: no registry / no credential resolves to undefined", async () => {
  assert.equal(await resolveProviderCredential(undefined, "github-copilot", undefined), undefined);
  assert.equal(
    await resolveProviderCredential({ getApiKeyForProvider: async () => undefined }, "github-copilot", undefined),
    undefined,
  );
});
