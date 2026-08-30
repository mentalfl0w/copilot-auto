import { describe, expect, test } from "bun:test";
import {
  wrapPiProvider,
  type Model,
  type NativeStreamSimple,
  type PiProvider,
  type RoutePlan,
  type RouteResolver,
  type WrapPiProviderOptions,
} from "./pi-native-provider.ts";

function model(id: string, extra: Record<string, unknown> = {}): Model {
  return { id, name: id, ...extra };
}

function baseProvider(models: Model[]): PiProvider {
  return {
    id: "github-copilot",
    name: "GitHub Copilot",
    getModels: () => models,
    stream: (_model, context, options) => ({ kind: "stream", context, options }),
    streamSimple: (_model, context, options) => ({ kind: "simple", context, options }),
    filterModels: (entries, credential) => {
      if (typeof credential === "function") return entries.filter(credential as (entry: Model) => boolean);
      return entries;
    },
    refreshModels: async () => undefined,
  };
}

function options(overrides: Partial<WrapPiProviderOptions> = {}): WrapPiProviderOptions {
  return {
    template: model("template", { api: "openai-responses", contextWindow: 400_000 }),
    visiblePool: ["gpt4", "claude"],
    routeResolver: async (id): Promise<RoutePlan> => ({
      realModelId: id === "auto" ? "gpt4" : id.slice("auto-".length),
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
      sessionToken: "route-token",
      source: "test",
    }),
    nativeStreamSimple: async (resolvedModel, context, requestOptions) => ({ resolvedModel, context, requestOptions }),
    lazyStream: (_model, setup) => setup(),
    ...overrides,
  };
}

describe("Pi native provider model catalog", () => {
  test("adds auto and only visible-pool aliases", () => {
    const wrapper = wrapPiProvider(baseProvider([model("gpt4", { api: "openai-responses" }), model("claude", { api: "anthropic-messages" }), model("other")]), options({ visiblePool: ["gpt4"] }));
    expect(wrapper.getModels().map((entry) => entry.id)).toEqual(["gpt4", "claude", "other", "auto", "auto-gpt4"]);
  });

  test("copies real model metadata into aliases", () => {
    const wrapper = wrapPiProvider(baseProvider([model("gpt4", { api: "openai-responses", contextWindow: 128_000, compat: { strict: true } })]), options({ visiblePool: ["gpt4"] }));
    expect(wrapper.getModels().find((entry) => entry.id === "auto-gpt4")).toMatchObject({ id: "auto-gpt4", name: "gpt4 (auto)", api: "openai-responses", contextWindow: 128_000, compat: { strict: true } });
  });

  test("does not expose aliases whose real model is absent", () => {
    const wrapper = wrapPiProvider(baseProvider([model("gpt4")]), options({ visiblePool: ["gpt4", "missing"] }));
    expect(wrapper.getModels().map((entry) => entry.id)).toEqual(["gpt4", "auto", "auto-gpt4"]);
  });

  test("removes pre-existing auto entries", () => {
    const wrapper = wrapPiProvider(baseProvider([model("auto"), model("auto-old"), model("gpt4")]), options({ visiblePool: ["gpt4"] }));
    const ids = wrapper.getModels().map((entry) => entry.id);
    expect(ids.filter((id) => id === "auto")).toHaveLength(1);
    expect(ids).not.toContain("auto-old");
  });
});
test("supplemental catalog restores models hidden by a provider overlay", async () => {
  const calls: Model[] = [];
  const wrapper = wrapPiProvider(
    baseProvider([model("auto", { api: "openai-responses" })]),
    options({
      catalog: [model("gpt4", { api: "openai-responses", baseUrl: "https://api.example.test" })],
      visiblePool: ["gpt4"],
      nativeStreamSimple: async (resolved) => {
        calls.push(resolved);
        return "ok";
      },
    }),
  );
  expect(wrapper.getModels().map((entry) => entry.id)).toEqual(["gpt4", "auto", "auto-gpt4"]);
  await wrapper.streamSimple(model("auto"), {});
  expect(calls[0]).toMatchObject({ id: "gpt4", api: "openai-responses" });
});

describe("Pi native provider delegation", () => {
  test("passes ordinary models through", async () => {
    const wrapper = wrapPiProvider(baseProvider([model("gpt4")]), options({ visiblePool: [] }));
    expect(await wrapper.stream(model("gpt4"), { request: 1 })).toEqual({ kind: "stream", context: { request: 1 }, options: undefined });
    expect(await wrapper.streamSimple(model("gpt4"), { request: 2 })).toEqual({ kind: "simple", context: { request: 2 }, options: undefined });
  });

  test("routes alias through selected native api with request-local headers", async () => {
    const calls: Array<{ model: Model; context: unknown; options: Record<string, unknown> }> = [];
    const native: NativeStreamSimple = async (resolvedModel, context, requestOptions) => {
      calls.push({ model: resolvedModel, context, options: requestOptions ?? {} });
      return "done";
    };
    const resolver: RouteResolver = async (managedId, _context, requestOptions) => {
      expect(managedId).toBe("auto-gpt4");
      expect(requestOptions).toMatchObject({ sessionId: "s1" });
      return {
        realModelId: "gpt4",
        api: "openai-completions",
        baseUrl: "https://api.githubcopilot.com",
        sessionToken: "token-a",
        interactionId: "interaction-a",
        reasoningBucket: "medium",
        source: "forced",
      };
    };
    const wrapper = wrapPiProvider(
      baseProvider([model("gpt4", { api: "openai-responses", contextWindow: 12 })]),
      options({
        visiblePool: ["gpt4"],
        routeResolver: resolver,
        nativeStreamSimple: native,
        headers: { "User-Agent": "GitHubCopilotChat/0.35.0" },
      }),
    );
    await wrapper.streamSimple(model("auto-gpt4"), { prompt: "hello" }, { sessionId: "s1", headers: { Authorization: "Bearer x", "copilot-session-token": "wrong" } });
    expect(calls[0].model).toMatchObject({ id: "gpt4", api: "openai-completions", baseUrl: "https://api.githubcopilot.com", contextWindow: 12 });
    expect(calls[0].options).toMatchObject({
      sessionId: "s1",
      reasoning: "medium",
      headers: {
        Authorization: "Bearer x",
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Copilot-Session-Token": "token-a",
        "X-Interaction-Id": "interaction-a",
      },
    });
    expect(calls[0].options.headers).not.toHaveProperty("copilot-session-token");
  });

  test("removes an inherited session token when the route omits it", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const wrapper = wrapPiProvider(
      baseProvider([model("gpt4", { api: "openai-responses" })]),
      options({
        visiblePool: [],
        routeResolver: async (): Promise<RoutePlan> => ({
          realModelId: "gpt4",
          api: "openai-responses",
          source: "sticky",
          omitSessionToken: true,
        }),
        nativeStreamSimple: async (_model, _context, requestOptions) => {
          forwarded = requestOptions as Record<string, unknown>;
          return "ok";
        },
      }),
    );

    await wrapper.streamSimple(model("auto"), {}, {
      headers: new Headers({
        "Copilot-Session-Token": "stale-token",
        Authorization: "Bearer caller",
      }),
    });

    expect(forwarded?.headers).toEqual({ authorization: "Bearer caller" });
  });

  test("plain auto may select a cross-family model", async () => {
    const calls: Model[] = [];
    const wrapper = wrapPiProvider(baseProvider([model("claude", { api: "anthropic-messages" })]), options({ visiblePool: [], routeResolver: async (): Promise<RoutePlan> => ({ realModelId: "claude", api: "anthropic-messages", source: "session-intent" }), nativeStreamSimple: async (resolved) => { calls.push(resolved); return "ok"; } }));
    await wrapper.streamSimple(model("auto"), {});
    expect(calls[0]).toMatchObject({ id: "claude", api: "anthropic-messages" });
  });

  test("rejects aliases outside pool and forced target mismatches", async () => {
    const outside = wrapPiProvider(baseProvider([model("gpt4"), model("claude")]), options({ visiblePool: ["gpt4"], routeResolver: async (): Promise<RoutePlan> => ({ realModelId: "claude", api: "anthropic-messages", source: "forced" }) }));
    await expect(outside.stream(model("auto-claude"), {})).rejects.toThrow(/current session pool/);
    const mismatch = wrapPiProvider(baseProvider([model("gpt4"), model("claude")]), options({ visiblePool: ["gpt4"], routeResolver: async (): Promise<RoutePlan> => ({ realModelId: "claude", api: "anthropic-messages", source: "forced" }) }));
    await expect(mismatch.stream(model("auto-gpt4"), {})).rejects.toThrow(/resolved to "claude"/);
  });

  test("delegates refresh and filter", async () => {
    let refreshed = false;
    const base = baseProvider([model("gpt4")]);
    base.refreshModels = async () => { refreshed = true; };
    const wrapper = wrapPiProvider(base, options({ visiblePool: [] }));
    await wrapper.refreshModels?.({ signal: undefined });
    expect(refreshed).toBe(true);
    expect(wrapper.filterModels?.([model("gpt4"), model("other")], (entry: Model) => entry.id === "gpt4")).toHaveLength(1);
  });
});
