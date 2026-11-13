/**
 * Unit tests for the Lab model catalog (`GET /models`).
 *
 * Regression: `providerCatalog()` called `ctx.llm.listModels(provider.name)`
 * with the provider DISPLAY name (e.g. "腾讯云 Token Plan", "DeepSeek"), while
 * the DSH `llm` service keys its adapter registry by provider ROUTE ID
 * ("tencent-token-plan", "deepseek-official"). The lookup threw NO_ADAPTER,
 * the inner catch turned that into an empty list, and `GET /models` advertised
 * `providers[].models = []` for every provider — so the Lab UI model pickers
 * had no model choices and a provider's models could not be selected.
 *
 * Run with: `node --test tests/`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelCatalog, resolveModelSelection } from '../host/models.js';

const DEFAULT_SELECTION = {
  provider: 'tencent-token-plan',
  model: 'deepseek/deepseek-flash',
  reasoningEffort: 'max',
};

function projectWithRoles(models) {
  return {
    id: 'prj-test',
    config: { modelOptions: [], models, routing: {} },
  };
}

function fakeCtx(seen) {
  return {
    agentDefaultModel: { currentSelection: () => ({ ...DEFAULT_SELECTION }) },
    llm: {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'tencent-token-plan', name: '腾讯云 Token Plan' },
      ],
      // Only a route id resolves; a display name is an unknown adapter (like
      // the real LlmRuntime, which looks the route up in its adapter map).
      listModels: async (provider) => {
        seen.push(provider);
        if (provider !== 'tencent-token-plan') return [];
        return [{ id: 'deepseek/deepseek-flash', name: 'DeepSeek-V4.1-Flash' }];
      },
      resolveModelInfo: async (provider, model) => ({
        provider,
        id: model,
        name: 'DeepSeek-V4.1-Flash',
        context: { contextWindow: 1000000 },
        reasoning: { efforts: [{ id: 'max' }], defaultEffort: 'max' },
      }),
    },
  };
}

test('provider catalog queries listModels by route id, not display name', async () => {
  const seen = [];
  const catalog = await buildModelCatalog(fakeCtx(seen), projectWithRoles({ roles: {} }));

  assert.deepEqual([...seen].sort(), ['deepseek-official', 'tencent-token-plan']);

  const tokenPlan = catalog.providers.find((provider) => provider.id === 'tencent-token-plan');
  assert.ok(tokenPlan, 'tencent-token-plan must be listed');
  assert.equal(tokenPlan.name, '腾讯云 Token Plan');
  assert.deepEqual(tokenPlan.models, [
    { id: 'deepseek/deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
  ]);

  // A provider with no credential/models still keeps its identity and offers no
  // choices — but the catalog must have asked it by route id too.
  const deepseek = catalog.providers.find((provider) => provider.id === 'deepseek-official');
  assert.equal(deepseek.name, 'DeepSeek');
  assert.deepEqual(deepseek.models, []);
});

test('project role models resolve to the pinned provider for every lab role', () => {
  const role = { ...DEFAULT_SELECTION };
  const project = projectWithRoles({
    roles: { worker: role, advisor: role, scheduler: role, controller: role, merge: role, gc: role },
  });
  const ctx = fakeCtx([]);

  for (const name of ['worker', 'advisor', 'scheduler', 'controller', 'merge', 'gc']) {
    const selection = resolveModelSelection(ctx, project, null, name);
    assert.equal(selection.provider, 'tencent-token-plan', `${name} provider`);
    assert.equal(selection.model, 'deepseek/deepseek-flash', `${name} model`);
    assert.equal(selection.reasoningEffort, 'max', `${name} effort`);
    assert.equal(selection.source, 'project-role', `${name} source`);
  }
});
