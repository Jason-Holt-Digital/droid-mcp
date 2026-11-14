import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../src/config.ts';
import { checkEffort, checkModel, parseCustomModels, parseHelp } from '../src/models.ts';
import { addTags, toRestSettings, toUpdate, validateSettings } from '../src/settings.ts';
import { catalog, HELP, SECRET, SETTINGS } from './helpers.ts';

test('parseHelp reads built-in models, reasoning, aliases and wildcards from droid exec --help', () => {
  const h = parseHelp(HELP);
  assert.ok(h.builtin.length > 50);
  assert.equal(h.defaultModel, 'gpt-6.1-sol');
  const sol = h.builtin.find((b) => b.id === 'gpt-6.1-sol')!;
  assert.equal(sol.name, 'GPT-6.1 Sol');
  assert.equal(sol.isDefault, true);
  const opus = h.builtin.find((b) => b.id === 'claude-opus-5-5')!;
  assert.deepEqual(opus.reasoning, { supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' });
  const deprecated = h.builtin.find((b) => b.id === 'deepseek-v4-pro')!;
  assert.equal(deprecated.name, 'DeepSeek V4 Pro');
  assert.equal(deprecated.deprecated, true);
  assert.ok(deprecated.reasoning, 'deprecated models still match their reasoning line');
  assert.ok(!h.builtin.some((b) => b.id.startsWith('custom:')), 'custom models come from settings, not the help');
  for (const a of ['anthropic-latest-premium', 'anthropic-latest-fast', 'openai-latest-medium', 'oss-latest-fast']) assert.ok(h.aliases.includes(a), a);
  assert.ok(!h.aliases.includes('oss-latest-medium'));
  for (const w of ['claude-opus-*', 'gpt-*-sol', 'glm-*', 'claude-opus-*-fast']) assert.ok(h.wildcards.includes(w), w);
});

test('parseCustomModels keeps only allowlisted fields and the URL host', () => {
  const custom = parseCustomModels(SETTINGS);
  assert.deepEqual(custom, [
    {
      id: 'custom:my-proxy:opus-5-5',
      displayName: 'My proxy: Opus 5.5',
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      baseUrlHost: 'localhost:8080',
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      maxContextLimit: 200000,
    },
  ]);
  const json = JSON.stringify(custom);
  for (const bad of ['apiKey', 'apiKeyHelper', 'headers', SECRET, 'token=', '/v1']) assert.ok(!json.includes(bad), bad);
  assert.deepEqual(parseCustomModels(undefined), []);
  assert.deepEqual(parseCustomModels({ customModels: 'x' }), []);
});

test('checkModel accepts built-in, custom, alias and wildcard ids and suggests close matches for typos', () => {
  const c = catalog();
  for (const id of ['claude-opus-5-5', 'custom:my-proxy:opus-5-5', 'anthropic-latest-premium', 'claude-opus-*']) checkModel(id, c);
  assert.throws(
    () => checkModel('claude-opus-5-6', c),
    (err: Error) => {
      assert.ok(err instanceof Refused);
      assert.match(err.message, /^unknown model 'claude-opus-5-6'; close matches: .*claude-opus-5-5.* \(call droid_models for the full list\)$/);
      assert.ok(err.message.split('close matches: ')[1].split(' (')[0].split(', ').length <= 5);
      return true;
    },
  );
  assert.throws(() => checkModel('zzz', c), /no close matches/);
});

test('checkEffort enforces the efforts a model supports when they are known', () => {
  const c = catalog();
  checkEffort('max', 'claude-opus-5-5', c);
  assert.throws(() => checkEffort('off', 'claude-opus-5-5', c), /'off' is not supported by claude-opus-5-5; supported: low, medium, high, xhigh, max/);
  checkEffort('high', 'custom:my-proxy:opus-5-5', c);
  assert.throws(() => checkEffort('medium', 'custom:my-proxy:opus-5-5', c), Refused);
  checkEffort('off', 'anthropic-latest-premium', c);
});

test('validateSettings checks models, efforts and mode combinations', () => {
  const c = catalog();
  validateSettings({ model: 'claude-opus-5-5', reasoningEffort: 'high', specModel: 'gpt-6.1-sol' }, 'off', c);
  assert.throws(() => validateSettings({ specModel: 'nope' }, 'off', c), /unknown model 'nope'/);
  assert.throws(() => validateSettings({ model: 'claude-opus-5-5', specReasoningEffort: 'off' }, 'off', c), /not supported by claude-opus-5-5/);
  assert.throws(() => validateSettings({ mission: true }, 'medium', c), /mission mode requires autonomy "high"/);
  assert.throws(() => validateSettings({ workerModel: 'claude-opus-5-5' }, 'high', c), /workerModel need mission: true/);
  assert.throws(() => validateSettings({ mission: true, useSpec: true }, 'high', c), /cannot be combined/);
  assert.throws(() => validateSettings({ mission: true, workerModel: 'gpt-6.1-sol', workerReasoningEffort: 'off' }, 'high', c), /not supported by gpt-6.1-sol/);
  validateSettings({ mission: true, workerModel: 'gpt-6.1-sol', validatorModel: 'claude-opus-*', validatorReasoningEffort: 'off' }, 'high', c);
});

test('toUpdate maps run settings to updateSettings params', () => {
  assert.equal(toUpdate({}), undefined);
  assert.equal(toUpdate({ tags: ['x'], worktree: true, appendSystemPrompt: 'p', fork: 'f', useSpec: false }), undefined);
  assert.deepEqual(toUpdate({ model: 'm', reasoningEffort: 'high', specModel: 's', specReasoningEffort: 'low', useSpec: true }), {
    modelId: 'm',
    reasoningEffort: 'high',
    specModeModelId: 's',
    specModeReasoningEffort: 'low',
    interactionMode: 'spec',
  });
  assert.deepEqual(toUpdate({ mission: true, workerModel: 'w', validatorReasoningEffort: 'max' }), {
    interactionMode: 'mission',
    missionSettings: { workerModel: 'w', validationWorkerReasoningEffort: 'max' },
  });
  assert.deepEqual(toUpdate({ onlyTools: ['Read'], addTools: ['MCP:x'], removeTools: ['Execute'] }), {
    restrictToolIds: ['Read'],
    additionalToolIds: ['MCP:x'],
    disabledToolIds: ['Execute'],
  });
});

test('toRestSettings maps what REST supports and lists the rest as ignored', () => {
  assert.deepEqual(toRestSettings({}), { sessionSettings: {}, ignored: [] });
  assert.deepEqual(
    toRestSettings({
      model: 'm',
      reasoningEffort: 'high',
      specModel: 's',
      specReasoningEffort: 'low',
      useSpec: true,
      onlyTools: ['Read'],
      addTools: ['Grep'],
      removeTools: ['Execute'],
      mission: true,
      workerModel: 'w',
      validatorModel: 'v',
      tags: ['t'],
      worktree: 'b',
      appendSystemPrompt: 'p',
      fork: 'f',
    }),
    {
      sessionSettings: {
        model: 'm',
        reasoningEffort: 'high',
        specModeModel: 's',
        specModeReasoningEffort: 'low',
        interactionMode: 'spec',
        restrictToolIds: ['Read'],
        enabledToolIds: ['Grep'],
        disabledToolIds: ['Execute'],
      },
      ignored: ['mission', 'workerModel', 'validatorModel', 'tags', 'appendSystemPrompt', 'worktree', 'fork'],
    },
  );
});

test('addTags keeps existing tags and their metadata', () => {
  const existing = [{ name: 'droid-mcp' }, { name: 'pr', metadata: { url: 'u' } }];
  assert.deepEqual(addTags(existing, ['pr', 'new', 'new']), [...existing, { name: 'new' }]);
  assert.deepEqual(addTags(undefined, ['a']), [{ name: 'a' }]);
});
