import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { SCENARIO_PRESET_LIST } from '@mahoshojo/domain/scenario-presets';
import { BUILTIN_ARENA_NEWS_PACKAGE_REF } from '@mahoshojo/web-package';
import { prepareDesktopRoomSource } from '../src/features/arena/room-source';
import { createInitialArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import { clearDesktopArenaSource } from '../src/features/arena/strict-source';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Combatant = ArenaDraft['combatants'][number];
const online = (patch: Partial<Combatant> = {}): Combatant => ({
  type: 'general-character', filename: 'online.json', isPreset: false, isValid: false,
  desktopSource: 'online', sourceDataCardId: 'online-card', sourceDataCardUpdatedAt: 'observed-version',
  data: { name: '在线角色', content: 'private-online-body' }, ...patch,
});
const local = (patch: Partial<Combatant> = {}): Combatant => ({
  type: 'general-character', filename: 'local.json', isPreset: false, isValid: false,
  data: { name: '本地角色', content: 'private-local-body' }, ...patch,
});
const material = (id: string) => ({
  id, name: `素材 ${id}`, fileName: null, sourceKind: 'raw-json', sourceType: 'raw-json',
  content: { content: 'private-material-body' },
});
const draft = (patch: Partial<ArenaDraft> = {}): ArenaDraft => ({
  ...createInitialArenaDraft(), combatants: [online()], ...patch,
});
const freezeDeep = <T,>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
};
const digest = (canonical: string) => `sha256:${createHash('sha256').update(canonical).digest('hex')}`;

describe('Desktop Room current-source adapter', () => {
  it('shares a current online selection only with its actually observed version', async () => {
    const input = freezeDeep(draft({ combatants: [online({
      sourceDataCardId: ' online-card ', sourceDataCardUpdatedAt: ' observed-version ',
      characterGuidance: ' 保护队友 ',
    })] }));
    const before = structuredClone(input);
    const result = await prepareDesktopRoomSource(input);
    expect(result).toMatchObject({ ok: true, sharedConfig: {
      combatants: [{ key: 'data-card:online-card', characterGuidance: '保护队友',
        ref: { id: 'online-card', kind: 'character', versionToken: 'observed-version' } }],
      historySettings: { readArenaHistoryLimit: 10 },
    } });
    expect(Object.keys(result).sort()).toEqual(['ok', 'sharedConfig']);
    expect(JSON.stringify(result)).not.toContain('private-online-body');
    expect(input).toEqual(before);
  });

  it.each([undefined, '', '   '])('fails clearly when an online selection has no observed version (%s)', async (version) => {
    const input = freezeDeep(draft({ combatants: [online({ sourceDataCardUpdatedAt: version,
      data: { name: '在线角色', _updatedAt: 'not-observed', updatedAt: 'not-observed',
        cloudRef: { id: 'cached-card', version: 'cached-version' } },
    })] }));
    const before = structuredClone(input);
    const result = await prepareDesktopRoomSource(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected unshareable source');
    expect(result.issues).toEqual([expect.stringMatching(/combatants\[0\].*在线内容引用缺少版本信息.*重新选择/)]);
    expect(result).not.toHaveProperty('sharedConfig');
    expect(input).toEqual(before);
  });

  it('projects a real preset and local card without sharing their complete bodies', async () => {
    const preset = PRESET_LIST[0]!;
    const presetBody = { z: { b: 2, a: 1 }, name: '预设角色', arena_history: { entries: ['private-history-body'] } };
    const localBody = { z: { b: 2, a: 1 }, name: '本地角色', _cardId: 'body-metadata' };
    const input = freezeDeep(draft({ combatants: [
      local({ type: preset.type, filename: preset.filename, isPreset: true, desktopSource: 'preset', data: presetBody }),
      local({ data: localBody }),
    ] }));
    const result = await prepareDesktopRoomSource(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.sharedConfig.combatants).toEqual([
      { key: `preset:${preset.filename}`, ref: { id: preset.filename, kind: 'character',
        versionToken: digest('{"arena_history":{"entries":["private-history-body"]},"name":"预设角色","z":{"a":1,"b":2}}') } },
      { key: expect.stringMatching(/^host-local:character:/), displayName: '本地角色', type: 'general-character', source: 'host-local',
        contentVersion: digest('{"_cardId":"body-metadata","name":"本地角色","z":{"a":1,"b":2}}') },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-history-body');
    expect(JSON.stringify(result)).not.toContain('body-metadata');
    expect(input.combatants[0]!.data).toEqual(presetBody);
  });

  it('uses recursive canonical full-body hashing rather than a local-library dedupe digest', async () => {
    const first = await prepareDesktopRoomSource(draft({ combatants: [local({
      data: { name: '角色', nested: { z: 2, a: [3, { y: 4, b: 5 }] }, _cardId: 'one' },
    })] }));
    const reordered = await prepareDesktopRoomSource(draft({ combatants: [local({
      data: { _cardId: 'one', nested: { a: [3, { b: 5, y: 4 }], z: 2 }, name: '角色' },
    })] }));
    const changedMetadata = await prepareDesktopRoomSource(draft({ combatants: [local({
      data: { name: '角色', nested: { z: 2, a: [3, { y: 4, b: 5 }] }, _cardId: 'two' },
    })] }));
    expect(first.ok && reordered.ok && changedMetadata.ok).toBe(true);
    expect(first).toEqual(reordered);
    expect(first).not.toEqual(changedMetadata);
  });

  it('strips obsolete online and preset identities after restore or role replacement', async () => {
    const preset = PRESET_LIST[0]!;
    const input = freezeDeep(draft({ combatants: [
      clearDesktopArenaSource(online()),
      clearDesktopArenaSource(local({ filename: preset.filename, type: preset.type, isPreset: true, desktopSource: 'preset' })),
      local({ filename: preset.filename, isPreset: true, sourceDataCardId: 'local-stale-id', sourceDataCardUpdatedAt: 'old',
        data: { name: '本地缓存', _cardId: 'forged', cloudRef: { id: 'forged', updatedAt: 'old' } } }),
    ] }));
    const before = structuredClone(input);
    const result = await prepareDesktopRoomSource(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.sharedConfig.combatants).toHaveLength(3);
    for (const item of result.sharedConfig.combatants) {
      expect(item).toMatchObject({ source: 'host-local', contentVersion: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
      expect(item).not.toHaveProperty('ref');
    }
    expect(JSON.stringify(result)).not.toContain('local-stale-id');
    expect(JSON.stringify(result)).not.toContain('forged');
    expect(input).toEqual(before);
  });

  it('does not let an obsolete online ID override a current real preset selection', async () => {
    const preset = PRESET_LIST[0]!;
    const result = await prepareDesktopRoomSource(draft({ combatants: [local({
      filename: preset.filename, type: preset.type, isPreset: true, desktopSource: 'preset',
      sourceDataCardId: 'obsolete-online-id', sourceDataCardUpdatedAt: 'obsolete-online-version',
    })] }));
    expect(result).toMatchObject({ ok: true, sharedConfig: {
      combatants: [{ key: `preset:${preset.filename}`, ref: { id: preset.filename, kind: 'character' } }],
    } });
    expect(JSON.stringify(result)).not.toContain('obsolete-online');
  });

  it('maps current teams, main and auxiliary scenarios, materials and history settings', async () => {
    const preset = SCENARIO_PRESET_LIST[0]!;
    const input = freezeDeep(draft({
      battleMode: 'scenario', combatants: [online({ teamId: 4 }), local({ teamId: 4 })],
      teams: [{ id: 4, name: ' 守护队 ' }],
      scenario: { content: { title: '主情景', content: 'private-main-body' }, fileName: preset.filename, isPreset: true },
      auxScenarios: [
        { content: { title: '本地辅助', content: 'private-aux-body' }, fileName: preset.filename },
        { content: { title: '预设辅助' }, fileName: preset.filename, isPreset: true },
      ],
      materials: [material('material-a')],
      storyLength: 'detailed', customStoryLength: ' 2400 ', selectedLanguage: 'en-US',
      settings: { ...createInitialArenaDraft().settings, userGuidance: '保持紧凑', readArenaHistoryLimit: 7,
        readNarrativeHistory: true, readNarrativeHistoryLimit: 12, writeCurrentState: false },
    }));
    const before = structuredClone(input);
    const result = await prepareDesktopRoomSource(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.sharedConfig).toMatchObject({
      battleMode: 'scenario', teams: [{ key: 'team:4', displayName: '守护队',
        combatantKeys: ['data-card:online-card', result.sharedConfig.combatants[1]!.key] }],
      scenario: { key: `preset:${preset.filename}`, ref: { id: preset.filename, kind: 'scenario' } },
      auxScenarios: [{ source: 'host-local', type: 'scenario' }, { key: `preset:${preset.filename}` }],
      materials: [{ source: 'host-local', type: 'material', displayName: '素材 material-a' }],
      storyLength: 'detailed', customStoryLength: '2400', selectedLanguage: 'en-US', userGuidance: '保持紧凑',
      historySettings: { readArenaHistoryLimit: 7, readNarrativeHistory: true, readNarrativeHistoryLimit: 12, writeCurrentState: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-(main|aux|material)-body/);
    expect(input).toEqual(before);
  });

  it('never promotes material metadata-derived wrapper IDs or scenario filenames to online references', async () => {
    const input = draft({ battleMode: 'scenario',
      scenario: { content: { title: '上传主情景', _cardId: 'forged-main', _updatedAt: 'fake-version' },
        fileName: SCENARIO_PRESET_LIST[0]!.filename, sourceDataCardId: 'forged-main', sourceDataCardUpdatedAt: 'fake-version' },
      auxScenarios: [{ content: { title: '辅助', cloudRef: { id: 'cached-aux' } }, fileName: SCENARIO_PRESET_LIST[0]!.filename }],
      materials: [{ ...material('imported'), sourceDataCardId: 'metadata-derived-id', sourceDataCardUpdatedAt: 'metadata-derived-version',
        content: { _cardId: 'metadata-derived-id', _updatedAt: 'metadata-derived-version', cloudRef: { id: 'cached-material' }, content: '正文' } }],
    });
    const result = await prepareDesktopRoomSource(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join('; '));
    for (const item of [result.sharedConfig.scenario, ...result.sharedConfig.auxScenarios, ...result.sharedConfig.materials]) {
      expect(item).toMatchObject({ source: 'host-local', contentVersion: expect.stringMatching(/^sha256:/) });
      expect(item).not.toHaveProperty('ref');
    }
    expect(JSON.stringify(result)).not.toMatch(/forged-main|metadata-derived|cached-material|cached-aux/);
  });

  it('returns canonical empty settings only for the explicit empty choice and leaves the draft untouched', async () => {
    const input = freezeDeep(draft({ combatants: [online({ sourceDataCardUpdatedAt: undefined })],
      battleMode: 'scenario', settings: { ...createInitialArenaDraft().settings, userGuidance: '保留的本地引导' },
    }));
    const before = structuredClone(input);
    expect((await prepareDesktopRoomSource(input)).ok).toBe(false);
    expect(await prepareDesktopRoomSource(input, true)).toEqual({ ok: true, sharedConfig: {
      battleMode: 'classic', reportFormat: 'markdown', combatants: [], teams: [], scenario: null, auxScenarios: [], materials: [],
      userGuidance: '', storyLength: 'default', customStoryLength: null, selectedLanguage: 'zh-CN',
      historySettings: { readArenaHistory: true, readArenaHistoryLimit: 3, isArenaHistoryUnlimited: false, writeArenaHistory: true,
        readCurrentState: true, writeCurrentState: true, readNarrativeHistory: false, readNarrativeHistoryLimit: 10,
        isNarrativeHistoryUnlimited: false, writeNarrativeHistory: false },
    } });
    expect(input).toEqual(before);
    const currentEmpty = await prepareDesktopRoomSource(createInitialArenaDraft());
    expect(currentEmpty).toMatchObject({ ok: true, sharedConfig: { combatants: [], historySettings: { readArenaHistoryLimit: 10 } } });
  });

  it('shares only registered exact Web Package identities and never their local prompt projection', async () => {
    const builtin = await prepareDesktopRoomSource(draft({ reportFormat: 'web', webPackageRef: BUILTIN_ARENA_NEWS_PACKAGE_REF }));
    expect(builtin).toMatchObject({ ok: true, sharedConfig: { reportFormat: 'web', webPackageRef: BUILTIN_ARENA_NEWS_PACKAGE_REF } });
    const unregistered = await prepareDesktopRoomSource(draft({ reportFormat: 'web',
      webPackageRef: { ...BUILTIN_ARENA_NEWS_PACKAGE_REF, digest: 'sha256:' + 'f'.repeat(64) },
    }));
    expect(unregistered.ok).toBe(true);
    if (!unregistered.ok) throw new Error(unregistered.issues.join('; '));
    expect(unregistered.sharedConfig).not.toHaveProperty('webPackageRef');
    const markdown = await prepareDesktopRoomSource(draft({ webPackageRef: BUILTIN_ARENA_NEWS_PACKAGE_REF }));
    expect(markdown).not.toHaveProperty('sharedConfig.webPackageRef');
  });

  it('excludes provider, keys, generation internals and standalone history bodies from the boundary', async () => {
    const history = { id: 'history-id', title: '正文历史', content: 'private-narrative-body', createdAt: '', updatedAt: '' };
    const input = freezeDeep({
      ...draft({ narrativeHistoryEntries: [history], historyReferences: [history],
        historyOriginals: [{ id: 'original', name: '原文', text: 'private-original-body', importedAt: '' }],
        adjudicationEvents: [{ type: 'binary', description: 'private-adjudication-body', probability: 50 }],
      }),
      userProviderConfig: { apiKey: 'provider-secret', baseUrl: 'https://private-provider.invalid' },
      providerTarget: { token: 'private-token' }, generation: { id: 'private-generation' },
      webPackagePromptProjection: { privatePrompt: 'private-package-body' },
    });
    const before = structuredClone(input);
    const result = await prepareDesktopRoomSource(input as unknown as ArenaDraft);
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['ok', 'sharedConfig']);
    expect(JSON.stringify(result)).not.toMatch(/private-|provider|apiKey|hostLocalPayloads|historyReferences|adjudication|webPackagePromptProjection/);
    expect(input).toEqual(before);
  });

  it('preserves the 32-combatant and combined 256-reference limits without truncating', async () => {
    const roster = (count: number) => Array.from({ length: count }, (_, i) => online({ sourceDataCardId: `online-${i}` }));
    const acceptedRoster = await prepareDesktopRoomSource(draft({ combatants: roster(32) }));
    expect(acceptedRoster).toMatchObject({ ok: true, sharedConfig: { combatants: expect.any(Array) } });
    if (acceptedRoster.ok) expect(acceptedRoster.sharedConfig.combatants).toHaveLength(32);
    const rejectedRoster = await prepareDesktopRoomSource(draft({ combatants: roster(33) }));
    expect(rejectedRoster).toMatchObject({ ok: false, issues: [expect.stringMatching(/最多支持 32/)] });
    const auxScenarios = Array.from({ length: 128 }, (_, i) => ({ content: { title: `辅助 ${i}` }, fileName: null }));
    const materials = Array.from({ length: 128 }, (_, i) => material(String(i)));
    const acceptedReferences = await prepareDesktopRoomSource(draft({ auxScenarios, materials }));
    expect(acceptedReferences.ok).toBe(true);
    if (acceptedReferences.ok) {
      expect(acceptedReferences.sharedConfig.auxScenarios).toHaveLength(128);
      expect(acceptedReferences.sharedConfig.materials).toHaveLength(128);
    }
    const rejectedReferences = await prepareDesktopRoomSource(draft({ auxScenarios, materials: [...materials, material('extra')] }));
    expect(rejectedReferences).toMatchObject({ ok: false, issues: [expect.stringMatching(/最多支持 256/)] });
  });

  it('fails closed on malformed current content without leaking the body or exception details', async () => {
    const result = await prepareDesktopRoomSource(draft({ materials: [{ privateBody: 'secret-invalid-material' }] }));
    expect(result).toMatchObject({ ok: false, issues: [expect.stringMatching(/共享格式/)] });
    expect(JSON.stringify(result)).not.toContain('secret-invalid-material');
  });
});
