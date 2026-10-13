import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WebPackageRef } from '@mahoshojo/contracts/web-package';

import {
  ArenaRoomShareabilityError,
  createArenaRoomCanonicalEmptyDraftBundle,
  createArenaRoomSourceProjector,
  type ArenaRoomSourceState,
} from '../src/index';

const sha256Hex = async (value: string): Promise<string> => (
  createHash('sha256').update(value).digest('hex')
);
const projector = createArenaRoomSourceProjector({
  sha256Hex,
  isBuiltinWebPackageRef: () => false,
});

const source = (): ArenaRoomSourceState => ({
  battleMode: 'scenario',
  combatants: [
    { type: 'random-magical-girl', filename: 'random', teamId: 4 },
    {
      type: 'general-character',
      filename: 'online.json',
      data: { name: '在线角色', privateBody: 'online-body' },
      sourceDataCardId: ' online-character ',
      sourceDataCardUpdatedAt: ' character-v1 ',
      characterGuidance: ' 保护队友 ',
      teamId: 4,
    },
    {
      type: 'magical-girl',
      filename: 'M01.json',
      data: { name: '预设角色', nested: { power: 3 } },
      isPreset: true,
      teamId: 4,
    },
    {
      type: 'canshou',
      filename: 'local.json',
      data: { name: '本地残兽', privateBody: 'host-only-character' },
      arenaRoomKey: 'host-local:existing-character',
      teamId: 4,
    },
  ],
  teams: [{ id: 4, name: ' 第一队 ', roomKey: ' room-team ' }],
  scenario: {
    fileName: 'S01.json',
    content: { title: '预设情景', nested: { weather: 'sunny' } },
    isPreset: true,
  },
  auxScenarios: [
    {
      fileName: 'online-aux.json',
      content: { title: '在线辅助情景' },
      sourceDataCardId: 'online-scenario',
      sourceDataCardUpdatedAt: 'scenario-v1',
    },
    {
      fileName: 'local-aux.json',
      content: { title: '本地辅助情景', privateBody: 'host-only-scenario' },
      arenaRoomKey: 'host-local:existing-scenario',
    },
  ],
  materials: [
    {
      id: 'local-material',
      name: '本地素材',
      fileName: 'local-material.json',
      content: { privateBody: 'host-only-material' },
      arenaRoomKey: 'host-local:existing-material',
    },
    {
      id: 'online-material',
      name: '在线素材',
      fileName: 'online-material.json',
      content: { privateBody: 'online-material-body' },
      sourceDataCardId: 'online-material',
      sourceDataCardUpdatedAt: 'material-v1',
    },
  ],
  storyLength: 'detailed',
  customStoryLength: ' 2400 ',
  selectedLanguage: 'zh-CN',
  settings: {
    userGuidance: '保持紧凑',
    readArenaHistory: true,
    readArenaHistoryLimit: 5,
    isArenaHistoryUnlimited: false,
    writeArenaHistory: true,
    readCurrentState: true,
    writeCurrentState: false,
    readNarrativeHistory: true,
    readNarrativeHistoryLimit: 12,
    isNarrativeHistoryUnlimited: false,
    writeNarrativeHistory: false,
  },
});

describe('Arena Room shared source projection', () => {
  it('projects nonempty online refs, presets and local stubs without carrying host metadata', async () => {
    const input = { ...source(), userProviderConfig: { apiKey: 'provider-secret' } };
    const before = structuredClone(input);
    const bundle = await projector.buildArenaRoomHostWorkspaceBundleFromBattleState(input);

    expect(bundle.sharedConfig).toMatchObject({
      reportFormat: 'markdown',
      combatants: [
        {
          key: 'data-card:online-character',
          ref: { id: 'online-character', kind: 'character', versionToken: 'character-v1' },
          characterGuidance: '保护队友',
        },
        { key: 'preset:M01.json', ref: { id: 'M01.json', kind: 'character' } },
        {
          key: 'host-local:existing-character',
          source: 'host-local',
          displayName: '本地残兽',
          type: 'canshou',
        },
      ],
      teams: [{
        key: 'room-team',
        displayName: '第一队',
        combatantKeys: ['data-card:online-character', 'preset:M01.json', 'host-local:existing-character'],
      }],
      scenario: { key: 'preset:S01.json', ref: { id: 'S01.json', kind: 'scenario' } },
      auxScenarios: [
        {
          key: 'data-card:online-scenario',
          ref: { id: 'online-scenario', kind: 'scenario', versionToken: 'scenario-v1' },
        },
        { key: 'host-local:existing-scenario', source: 'host-local' },
      ],
      materials: [
        { key: 'host-local:existing-material', source: 'host-local' },
        {
          key: 'data-card:online-material',
          ref: { id: 'online-material', kind: 'material', versionToken: 'material-v1' },
        },
      ],
      userGuidance: '保持紧凑',
      customStoryLength: '2400',
      historySettings: { readArenaHistoryLimit: 5, readNarrativeHistoryLimit: 12 },
    });
    expect(bundle.hostLocalPayloads).toEqual([
      {
        key: 'host-local:existing-character', kind: 'character',
        payload: { name: '本地残兽', privateBody: 'host-only-character' },
      },
      {
        key: 'host-local:existing-scenario', kind: 'scenario',
        payload: { title: '本地辅助情景', privateBody: 'host-only-scenario' },
      },
      {
        key: 'host-local:existing-material', kind: 'material',
        payload: { privateBody: 'host-only-material' },
      },
    ]);
    for (const entry of bundle.hostLocalPayloads) {
      const digest = await projector.computeArenaRoomContentDigest(entry.payload);
      expect(bundle.hostLocalContentDigests).toContainEqual({ key: entry.key, digest });
      const stub = [
        ...bundle.sharedConfig.combatants,
        ...bundle.sharedConfig.auxScenarios,
        ...bundle.sharedConfig.materials,
      ].find((candidate) => candidate.key === entry.key);
      expect(stub).toMatchObject({ contentVersion: digest });
    }
    expect(JSON.stringify(bundle.sharedConfig)).not.toContain('privateBody');
    expect(JSON.stringify(bundle)).not.toContain('provider-secret');
    expect(input).toEqual(before);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.hostLocalPayloads)).toBe(true);
  });

  it('keeps preset and local content versions canonical and changes them only with content', async () => {
    const first = source();
    const reversed = {
      ...first,
      combatants: first.combatants.map((entry) => entry.filename === 'M01.json'
        ? { ...entry, data: { nested: { power: 3 }, omitted: undefined, name: '预设角色' } }
        : entry),
    };
    const firstBundle = await projector.buildArenaRoomHostWorkspaceBundleFromBattleState(first);
    expect(await projector.buildArenaRoomHostWorkspaceBundleFromBattleState(reversed)).toEqual(firstBundle);
    const changed = await projector.buildArenaRoomHostWorkspaceBundleFromBattleState({
      ...first,
      combatants: first.combatants.map((entry) => entry.filename === 'M01.json'
        ? { ...entry, data: { name: '预设角色', nested: { power: 4 } } }
        : entry),
    });
    expect(changed.sharedConfig.combatants[1]).not.toEqual(firstBundle.sharedConfig.combatants[1]);
    expect(changed.hostLocalContentDigests).toEqual(firstBundle.hostLocalContentDigests);
    const changedLocal = await projector.buildArenaRoomHostWorkspaceBundleFromBattleState({
      ...first,
      materials: first.materials.map((entry) => entry.id === 'local-material'
        ? { ...entry, content: { privateBody: 'changed-host-only-material' } } : entry),
    });
    expect(changedLocal.sharedConfig.materials[0]).not.toEqual(firstBundle.sharedConfig.materials[0]);
    expect(changedLocal.sharedConfig.materials[0]?.key).toBe(firstBundle.sharedConfig.materials[0]?.key);
    expect(changedLocal.hostLocalContentDigests).not.toEqual(firstBundle.hostLocalContentDigests);
    expect(JSON.stringify(changedLocal.sharedConfig)).not.toContain('changed-host-only-material');
    expect(firstBundle.sharedConfig.scenario).toMatchObject({
      ref: { versionToken: await projector.computeArenaRoomContentDigest(first.scenario.content) },
    });
    await expect(projector.computeArenaRoomContentDigest({ value: 'abc' })).resolves.toBe(
      'sha256:afef793fc69ce78450c4c66b8d52dd7c7779bfa4871c521469741f22d5dde564',
    );
  });

  it('passes sorted JSON, omitted undefined fields and null array entries to the injected hash', async () => {
    const hash = vi.fn(sha256Hex);
    const isolated = createArenaRoomSourceProjector({ sha256Hex: hash, isBuiltinWebPackageRef: () => false });
    await isolated.computeArenaRoomContentDigest({ z: undefined, b: [undefined, { z: 2, a: 1 }], a: true });
    expect(hash).toHaveBeenCalledExactlyOnceWith('{"a":true,"b":[null,{"a":1,"z":2}]}');
  });

  it('reports every missing online version at its original source index without producing an empty bundle', async () => {
    const input = source();
    const invalid = {
      ...input,
      combatants: input.combatants.map((entry) => 'data' in entry && entry.sourceDataCardId
        ? { ...entry, sourceDataCardUpdatedAt: undefined } : entry),
      scenario: { content: {}, fileName: 'online.json', sourceDataCardId: 'main-scenario' },
      auxScenarios: input.auxScenarios.map((entry) => entry.sourceDataCardId
        ? { ...entry, sourceDataCardUpdatedAt: ' ' } : entry),
      materials: input.materials.map((entry) => entry.sourceDataCardId
        ? { ...entry, sourceDataCardUpdatedAt: undefined } : entry),
    };
    const result = await projector.tryBuildArenaRoomHostWorkspaceBundleFromBattleState(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected shareability issues');
    expect(result.issues.map((issue) => ({ code: issue.code, target: issue.target }))).toEqual([
      { code: 'ROOM_REFERENCE_VERSION_REQUIRED', target: 'combatants[1]' },
      { code: 'ROOM_REFERENCE_VERSION_REQUIRED', target: 'scenario[0]' },
      { code: 'ROOM_REFERENCE_VERSION_REQUIRED', target: 'auxScenarios[0]' },
      { code: 'ROOM_REFERENCE_VERSION_REQUIRED', target: 'materials[1]' },
    ]);
    expect(result).not.toHaveProperty('bundle');
    await expect(projector.buildArenaRoomHostWorkspaceBundleFromBattleState(invalid))
      .rejects.toBeInstanceOf(ArenaRoomShareabilityError);
    await expect(projector.buildArenaRoomSharedConfigFromBattleState(invalid))
      .rejects.toMatchObject({ issues: result.issues });
  });

  it.each([
    [Number.NaN, 'ROOM_PAYLOAD_NON_FINITE_NUMBER'],
    [Number.POSITIVE_INFINITY, 'ROOM_PAYLOAD_NON_FINITE_NUMBER'],
    [() => 'not JSON', 'ROOM_PAYLOAD_JSON_INVALID'],
  ])('preserves payload normalization failures for %s', async (payload, code) => {
    const result = await projector.tryBuildArenaRoomHostWorkspaceBundleFromBattleState({
      ...source(),
      materials: [{ id: 'invalid', name: '无效素材', fileName: null, content: payload }],
    });
    expect(result).toMatchObject({ ok: false, issues: [{ code, target: 'materials[0]' }] });
  });

  it('preserves cycle detection while allowing reused non-circular objects', async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(projector.computeArenaRoomContentDigest(cycle)).rejects.toMatchObject({
      code: 'ROOM_PAYLOAD_CIRCULAR_REFERENCE',
    });
    const reused = { value: 1 };
    expect(await projector.computeArenaRoomContentDigest([reused, reused]))
      .toBe(await projector.computeArenaRoomContentDigest([{ value: 1 }, { value: 1 }]));
  });

  it('consults the host package catalogue only for Web reports and preserves the allowlist', async () => {
    const builtin = { id: 'builtin.report', version: '1', digest: `sha256:${'a'.repeat(64)}` };
    const accepts = vi.fn((ref: WebPackageRef) => ref.id === builtin.id);
    const isolated = createArenaRoomSourceProjector({ sha256Hex, isBuiltinWebPackageRef: accepts });
    const input = { ...source(), reportFormat: 'web' as const, webPackageRef: builtin };
    expect((await isolated.buildArenaRoomSharedConfigFromBattleState(input)).webPackageRef).toEqual(builtin);
    expect(accepts).toHaveBeenCalledExactlyOnceWith(builtin);
    expect((await isolated.buildArenaRoomSharedConfigFromBattleState({
      ...input, webPackageRef: { ...builtin, id: 'local.report' },
    })).webPackageRef).toBeUndefined();
    accepts.mockClear();
    expect((await isolated.buildArenaRoomSharedConfigFromBattleState({
      ...input, reportFormat: 'markdown',
    })).webPackageRef).toBeUndefined();
    expect(accepts).not.toHaveBeenCalled();
  });

  it('shares the existing canonical empty draft without using host ports or changing defaults', () => {
    const hash = vi.fn(sha256Hex);
    const builtin = vi.fn(() => false);
    const isolated = createArenaRoomSourceProjector({ sha256Hex: hash, isBuiltinWebPackageRef: builtin });
    expect(isolated.createArenaRoomCanonicalEmptyDraftBundle).toBe(createArenaRoomCanonicalEmptyDraftBundle);
    expect(isolated.createArenaRoomCanonicalEmptyDraftBundle()).toEqual({
      sharedConfig: {
        battleMode: 'classic', reportFormat: 'markdown', combatants: [], teams: [],
        scenario: null, auxScenarios: [], materials: [], userGuidance: '',
        storyLength: 'default', customStoryLength: null, selectedLanguage: 'zh-CN',
        historySettings: {
          readArenaHistory: true, readArenaHistoryLimit: 3, isArenaHistoryUnlimited: false,
          writeArenaHistory: true, readCurrentState: true, writeCurrentState: true,
          readNarrativeHistory: false, readNarrativeHistoryLimit: 10,
          isNarrativeHistoryUnlimited: false, writeNarrativeHistory: false,
        },
      },
      hostLocalPayloads: [], hostLocalContentDigests: [],
    });
    expect(hash).not.toHaveBeenCalled();
    expect(builtin).not.toHaveBeenCalled();
  });
});
