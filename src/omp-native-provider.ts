/**
 * OMP native-style provider adapter.
 *
 * OMP exposes provider config rather than Pi's complete Provider object. The
 * host supplies lazyStream so asynchronous routing returns a real stream.
 */

import type { CopilotCatalogModel, ReasoningBucket } from "./types.ts";

export const OMP_AUTO_API = "github-copilot-auto";
const AUTO_ALIAS_PREFIX = "auto-";

export interface OmpModel extends CopilotCatalogModel {
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface StreamRequestMeta {
  headers?: Headers | Record<string, string>;
  [key: string]: unknown;
}

export interface RoutePlan {
  realModelId: string;
  api: string;
  baseUrl?: string;
  sessionToken?: string;
  interactionId?: string;
  reasoningBucket?: ReasoningBucket;
  source: string;
  omitSessionToken?: boolean;
}

export type RouteResolver = (
  managedModelId: string,
  context: unknown,
  options?: unknown,
) => Promise<RoutePlan>;

export type NativeStreamSimple = (
  model: OmpModel,
  context: unknown,
  options?: StreamRequestMeta,
) => unknown;

export type LazyStream = (model: OmpModel, setup: () => Promise<unknown>) => unknown;

export interface OmpProviderOptions {
  catalog: readonly OmpModel[];
  /** Live catalog supplier when registration hides the base slice. */
  getCatalog?: () => readonly OmpModel[];
  /** Real model ids currently present in the Auto pool. */
  visiblePool: readonly string[];
  /** Optional live pool supplier used by dynamic refresh. */
  getVisiblePool?: () => readonly string[];
  routeResolver: RouteResolver;
  nativeStreamSimple: NativeStreamSimple;
  lazyStream: LazyStream;
}

interface OmpModelConfig extends OmpModel {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface OmpProviderConfig {
  api: typeof OMP_AUTO_API;
  models: OmpModelConfig[];
  streamSimple: (model: OmpModel, context: unknown, options?: StreamRequestMeta) => unknown;
  fetchDynamicModels: (apiKey?: string) => OmpModelConfig[];
}

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function isAutoId(id: string): boolean {
  return id === "auto" || id.startsWith(AUTO_ALIAS_PREFIX);
}

function aliasTargetId(aliasId: string): string {
  return aliasId.slice(AUTO_ALIAS_PREFIX.length);
}

function modelConfig(
  model: OmpModel,
  id = model.id,
  api = model.api ?? "openai-completions",
  name = model.name ?? id,
): OmpModelConfig {
  return {
    ...model,
    id,
    name,
    api,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: model.cost ?? DEFAULT_COST,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 8_192,
  };
}

function mergeRequestOptions(plan: RoutePlan, requestOptions?: StreamRequestMeta): StreamRequestMeta {
  const merged: StreamRequestMeta = { ...(requestOptions ?? {}) };
  const headers: Record<string, string> = {};
  const rawHeaders = requestOptions?.headers;
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((value, name) => { headers[name] = value; });
  } else if (rawHeaders) {
    Object.assign(headers, rawHeaders);
  }
  const removeRouteHeader = (name: string): void => {
    const lowerName = name.toLowerCase();
    for (const existingName of Object.keys(headers)) {
      if (existingName.toLowerCase() === lowerName) delete headers[existingName];
    }
  };
  const setRouteHeader = (name: string, value: string): void => {
    removeRouteHeader(name);
    headers[name] = value;
  };
  if (plan.sessionToken && !plan.omitSessionToken) {
    setRouteHeader("Copilot-Session-Token", plan.sessionToken);
  } else {
    removeRouteHeader("Copilot-Session-Token");
  }
  if (plan.interactionId) setRouteHeader("X-Interaction-Id", plan.interactionId);
  if (Object.keys(headers).length > 0) {
    merged.headers = headers;
  } else {
    delete merged.headers;
  }
  if (plan.reasoningBucket) merged.reasoning = plan.reasoningBucket;
  return merged;
}

export function buildOmpProviderConfig(options: OmpProviderOptions): OmpProviderConfig {
  const initialCatalog = [...options.catalog];
  const getCatalog = options.getCatalog ?? (() => initialCatalog);
  const getPool = options.getVisiblePool ?? (() => options.visiblePool);
  const template =
    initialCatalog.find((model) => !isAutoId(model.id)) ??
    ({ id: "auto", name: "Auto (Copilot)", api: "openai-responses" } as OmpModel);

  function catalogSnapshot(): Map<string, OmpModel> {
    return new Map(getCatalog().map((model) => [model.id, model]));
  }

  function buildModels(): OmpModelConfig[] {
    const catalog = catalogSnapshot();
    const result: OmpModelConfig[] = [];
    const seen = new Set<string>();
    const add = (model: OmpModelConfig): void => {
      if (seen.has(model.id)) return;
      seen.add(model.id);
      result.push(model);
    };

    for (const model of catalog.values()) {
      if (!isAutoId(model.id)) add(modelConfig(model));
    }
    add(modelConfig(template, "auto", OMP_AUTO_API, "Auto (Copilot)"));

    for (const realId of getPool()) {
      if (!realId || realId.startsWith(AUTO_ALIAS_PREFIX)) continue;
      const real = catalog.get(realId);
      if (real) add(modelConfig(real, `${AUTO_ALIAS_PREFIX}${realId}`, OMP_AUTO_API, `${real.name ?? realId} (auto)`));
    }
    return result;
  }

  const streamSimple: OmpProviderConfig["streamSimple"] = (model, context, requestOptions) => {
    const managedId = model.id;
    if (!isAutoId(managedId)) {
      throw new Error(`streamSimple received non-Auto model "${managedId}"; native models must use their built-in API`);
    }

    const targetId = managedId === "auto" ? undefined : aliasTargetId(managedId);
    const pool = new Set(getPool());
    if (targetId && !pool.has(targetId)) throw new Error(`Auto alias "${managedId}" is not in the current session pool`);

    return options.lazyStream(model, async () => {
      const plan = await options.routeResolver(managedId, context, requestOptions);
      if (!plan || typeof plan.realModelId !== "string" || plan.realModelId.length === 0) {
        throw new Error(`Auto route for "${managedId}" returned no real model`);
      }
      if (targetId && plan.realModelId !== targetId) {
        throw new Error(`Auto alias "${managedId}" resolved to "${plan.realModelId}" instead of "${targetId}"`);
      }
      if (targetId && !pool.has(plan.realModelId)) {
        throw new Error(`Auto alias target "${plan.realModelId}" is not in the current session pool`);
      }

      const catalogModel = catalogSnapshot().get(plan.realModelId);
      if (!catalogModel && targetId) {
        throw new Error(`Auto alias target "${plan.realModelId}" missing from catalog`);
      }
      const real = catalogModel ?? {
        id: plan.realModelId,
        name: plan.realModelId,
        api: plan.api,
        baseUrl: plan.baseUrl,
      };
      const resolvedModel = modelConfig(real, real.id, plan.api, real.name ?? real.id);
      if (plan.baseUrl !== undefined) resolvedModel.baseUrl = plan.baseUrl;
      return options.nativeStreamSimple(resolvedModel, context, mergeRequestOptions(plan, requestOptions));
    });
  };

  return {
    api: OMP_AUTO_API,
    models: buildModels(),
    streamSimple,
    fetchDynamicModels: () => buildModels(),
  };
}
