import { describe, expect, test } from "bun:test";
import {
  buildOmpProviderConfig,
  type NativeStreamSimple,
  type OmpProviderOptions,
  type RoutePlan,
  type RouteResolver,
} from "./omp-native-provider.ts";
import type { CopilotCatalogModel } from "./types.ts";

const BASE = "https://api.githubcopilot.com";
const INDIVIDUAL = "https://api.individual.githubcopilot.com";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const CATALOG: CopilotCatalogModel[] = [
  { provider: "github-copilot", id: "gpt-5.4", name: "GPT-5.4", api: "openai-responses", baseUrl: INDIVIDUAL, reasoning: true, input: ["text", "image"], cost: COST, contextWindow: 400_000, maxTokens: 128_000 },
  { provider: "github-copilot", id: "claude-sonnet-4-6", name: "Claude Sonnet", api: "anthropic-messages", baseUrl: BASE, reasoning: true, input: ["text", "image"], cost: COST, contextWindow: 200_000, maxTokens: 64_000, compat: { strict: true } },
];

function defaults(overrides: Partial<OmpProviderOptions> = {}): OmpProviderOptions {
  return {
    catalog: CATALOG,
    visiblePool: ["gpt-5.4"],
    routeResolver: async (managedId): Promise<RoutePlan> => ({
      realModelId: managedId === "auto" ? "gpt-5.4" : managedId.slice("auto-".length),
      api: "openai-responses",
      baseUrl: INDIVIDUAL,
      sessionToken: "route-token",
      source: "test",
    }),
    nativeStreamSimple: async (model, context, options) => ({ model, context, options }),
    lazyStream: (_model, setup) => setup(),
    ...overrides,
  };
}

describe("OMP native provider config", () => {
  test("contains native catalog, synthetic auto, and only current pool aliases", () => {
    const cfg = buildOmpProviderConfig(defaults());
    expect(cfg.api).toBe("github-copilot-auto");
    expect(cfg.models.map((entry) => entry.id)).toEqual(["gpt-5.4", "claude-sonnet-4-6", "auto", "auto-gpt-5.4"]);
    expect(cfg.models.find((entry) => entry.id === "gpt-5.4")?.api).toBe("openai-responses");
    expect(cfg.models.find((entry) => entry.id === "auto")?.api).toBe("github-copilot-auto");
  });

  test("aliases copy required metadata from real catalog models", () => {
    const cfg = buildOmpProviderConfig(defaults());
    const alias = cfg.models.find((entry) => entry.id === "auto-gpt-5.4");
    expect(alias).toMatchObject({ id: "auto-gpt-5.4", name: "GPT-5.4 (auto)", api: "github-copilot-auto", baseUrl: INDIVIDUAL, reasoning: true, input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000 });
    expect(alias?.cost).toEqual(COST);
  });

  test("catalog auto entries cannot keep stale aliases visible", () => {
    const catalog = [...CATALOG, { id: "auto-claude-sonnet-4-6", api: "openai-completions" }];
    const cfg = buildOmpProviderConfig(defaults({ catalog, visiblePool: ["gpt-5.4"] }));
    expect(cfg.models.some((entry) => entry.id === "auto-claude-sonnet-4-6")).toBe(false);
  });

  test("dynamic refresh uses the live pool and removes stale aliases", () => {
    let pool: readonly string[] = ["gpt-5.4"];
    const cfg = buildOmpProviderConfig(defaults({ visiblePool: [], getVisiblePool: () => pool }));
    expect(cfg.fetchDynamicModels().some((entry) => entry.id === "auto-gpt-5.4")).toBe(true);
    pool = ["claude-sonnet-4-6"];
    const refreshed = cfg.fetchDynamicModels();
    expect(refreshed.some((entry) => entry.id === "auto-gpt-5.4")).toBe(false);
    expect(refreshed.some((entry) => entry.id === "auto-claude-sonnet-4-6")).toBe(true);
  });
});

describe("OMP native stream delegation", () => {
  test("routes forced aliases through native transport with route-owned headers", async () => {
    let called: { model: CopilotCatalogModel; context: unknown; options: Record<string, unknown> } | undefined;
    const native: NativeStreamSimple = async (model, context, options) => {
      called = { model, context, options: options ?? {} };
      return "done";
    };
    let receivedOptions: unknown;
    const routeResolver: RouteResolver = async (id, context, options) => {
      expect(id).toBe("auto-gpt-5.4");
      expect(context).toEqual({ prompt: "hi" });
      receivedOptions = options;
      return {
        realModelId: "gpt-5.4",
        api: "openai-responses",
        baseUrl: INDIVIDUAL,
        sessionToken: "good-token",
        interactionId: "interaction-a",
        reasoningBucket: "low",
        source: "forced",
      };
    };
    const cfg = buildOmpProviderConfig(defaults({ routeResolver, nativeStreamSimple: native }));
    await cfg.streamSimple({ id: "auto-gpt-5.4" }, { prompt: "hi" }, { headers: { "copilot-session-token": "wrong", Authorization: "Bearer x" }, marker: true });
    expect(receivedOptions).toMatchObject({ marker: true });
    expect(called?.model).toMatchObject({ id: "gpt-5.4", api: "openai-responses", baseUrl: INDIVIDUAL });
    expect(called?.options).toMatchObject({
      headers: {
        "Copilot-Session-Token": "good-token",
        Authorization: "Bearer x",
        "X-Interaction-Id": "interaction-a",
      },
      reasoning: "low",
    });
    expect(called?.options.headers).not.toHaveProperty("copilot-session-token");
  });

  test("removes an inherited session token when the route omits it", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const cfg = buildOmpProviderConfig(defaults({
      routeResolver: async (): Promise<RoutePlan> => ({
        realModelId: "gpt-5.4",
        api: "openai-responses",
        source: "sticky",
        omitSessionToken: true,
      }),
      nativeStreamSimple: async (_model, _context, requestOptions) => {
        forwarded = requestOptions as Record<string, unknown>;
        return "ok";
      },
    }));

    await cfg.streamSimple(
      { id: "auto" },
      {},
      { headers: new Headers({ "Copilot-Session-Token": "stale-token", Authorization: "Bearer caller" }) },
    );

    expect(forwarded?.headers).toEqual({ authorization: "Bearer caller" });
  });

  test("does not retain a sole inherited session token when omitted", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const cfg = buildOmpProviderConfig(defaults({
      routeResolver: async (): Promise<RoutePlan> => ({
        realModelId: "gpt-5.4",
        api: "openai-responses",
        source: "sticky",
        omitSessionToken: true,
      }),
      nativeStreamSimple: async (_model, _context, requestOptions) => {
        forwarded = requestOptions as Record<string, unknown>;
        return "ok";
      },
    }));

    await cfg.streamSimple(
      { id: "auto" },
      {},
      { headers: new Headers({ "Copilot-Session-Token": "stale-token" }) },
    );

    expect(forwarded).not.toHaveProperty("headers");
  });

  test("plain auto may delegate a cross-family selected model", async () => {
    let resolved: CopilotCatalogModel | undefined;
    const cfg = buildOmpProviderConfig(defaults({
      visiblePool: [],
      routeResolver: async (): Promise<RoutePlan> => ({ realModelId: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: BASE, source: "session-intent" }),
      nativeStreamSimple: async (model) => { resolved = model; return "ok"; },
    }));
    await cfg.streamSimple({ id: "auto" }, {});
    expect(resolved).toMatchObject({ id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: BASE });
  });

  test("rejects non-auto handler calls and invalid forced pool targets", async () => {
    const cfg = buildOmpProviderConfig(defaults());
    expect(() => cfg.streamSimple({ id: "gpt-5.4" }, {})).toThrow(/non-Auto/);
    expect(() => cfg.streamSimple({ id: "auto-claude-sonnet-4-6" }, {})).toThrow(/current session pool/);
    const mismatch = buildOmpProviderConfig(defaults({ routeResolver: async (): Promise<RoutePlan> => ({ realModelId: "claude-sonnet-4-6", api: "anthropic-messages", source: "forced" }) }));
    await expect(mismatch.streamSimple({ id: "auto-gpt-5.4" }, {})).rejects.toThrow(/resolved to/);
  });

  test("rejects missing native delegate and missing catalog target", async () => {
    const missingNative = buildOmpProviderConfig(defaults({ nativeStreamSimple: undefined as unknown as NativeStreamSimple }));
    await expect(missingNative.streamSimple({ id: "auto-gpt-5.4" }, {})).rejects.toThrow();
    const missingCatalog = buildOmpProviderConfig(defaults({ visiblePool: ["orphan"], routeResolver: async (): Promise<RoutePlan> => ({ realModelId: "orphan", api: "openai-responses", source: "forced" }) }));
    await expect(missingCatalog.streamSimple({ id: "auto-orphan" }, {})).rejects.toThrow(/missing from catalog/);
  });
});
