import { describe, expect, it } from 'vitest';
import { ArenaRoomSessionResponseSchema, ArenaRoomSharedConfigSchema } from '@mahoshojo/contracts/arena-room';
import type { JsonValue } from '@mahoshojo/contracts/json-value';

import {
  arenaRoomHostWorkspaceAuthorityFromSession,
  createArenaRoomHostWorkspace,
  type ArenaRoomHostWorkspaceAuthority,
  type ArenaRoomHostWorkspaceBundle,
} from '../src/index';

const sharedConfig = (guidance = '', contentVersion = `sha256:${'a'.repeat(64)}`) => ({
  battleMode: 'classic' as const,
  reportFormat: 'markdown' as const,
  combatants: [{
    key: 'host-local:character:0:one',
    displayName: '本地角色',
    type: 'general-character' as const,
    source: 'host-local' as const,
    contentVersion,
  }],
  teams: [],
  scenario: null,
  auxScenarios: [],
  materials: [],
  userGuidance: guidance,
  storyLength: 'standard' as const,
  customStoryLength: null,
  selectedLanguage: 'zh-CN',
  historySettings: {
    readArenaHistory: true,
    readArenaHistoryLimit: 3,
    isArenaHistoryUnlimited: false,
    writeArenaHistory: true,
    readCurrentState: true,
    writeCurrentState: true,
    readNarrativeHistory: false,
    readNarrativeHistoryLimit: 10,
    isNarrativeHistoryUnlimited: false,
    writeNarrativeHistory: false,
  },
});

const bundle = (
  payload: Record<string, JsonValue> = { name: '本地角色', secret: 'baseline-body' },
  digest = `sha256:${'a'.repeat(64)}`,
  guidance = '',
): ArenaRoomHostWorkspaceBundle => ({
  sharedConfig: sharedConfig(guidance, digest),
  hostLocalPayloads: [{
    key: 'host-local:character:0:one',
    kind: 'character',
    payload,
  }],
  hostLocalContentDigests: [{ key: 'host-local:character:0:one', digest }],
});

const authority = (
  guidance = '',
  overrides: Partial<ArenaRoomHostWorkspaceAuthority> = {},
): ArenaRoomHostWorkspaceAuthority => ({
  roomId: 'room-1',
  roomEpoch: 'epoch-1',
  revision: 3,
  ownerUserId: 'host-1',
  sharedConfig: sharedConfig(guidance),
  ...overrides,
});

describe('Arena Room host workspace baseline', () => {
  it('旧房间配置经入口 schema 归一化后与显式 Markdown 工作副本一致', () => {
    const legacyConfig = Object.fromEntries(Object.entries(sharedConfig())
      .filter(([key]) => key !== 'reportFormat'));
    const normalizedAuthority = authority('', {
      sharedConfig: ArenaRoomSharedConfigSchema.parse(legacyConfig),
    });
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(normalizedAuthority, bundle());
    expect(workspace.compare(normalizedAuthority, bundle())).toMatchObject({
      kind: 'clean', start: { sharedConfig: { reportFormat: 'markdown' } },
    });
    expect(workspace.compare(normalizedAuthority, {
      ...bundle(), sharedConfig: { ...sharedConfig(), reportFormat: 'web' },
    })).toMatchObject({ kind: 'dirty', reasons: ['shared-config'] });
  });

  it('已显式发布的安全配置与本地摘要一致时直接启动', () => {
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authority(), bundle());

    const comparison = workspace.compare(authority(), bundle());
    expect(comparison).toMatchObject({ kind: 'clean' });
    if (comparison.kind !== 'clean') throw new Error('expected clean');
    expect(comparison.start.hostLocalPayloads).toEqual(bundle().hostLocalPayloads);
    expect(JSON.stringify(comparison.start.sharedConfig)).not.toContain('baseline-body');
  });

  it('stub 未变但本地正文改变时必须 preflight，按房间启动使用 baseline 正文', () => {
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authority(), bundle());
    const changed = bundle(
      { name: '本地角色', secret: 'changed-body' },
      `sha256:${'b'.repeat(64)}`,
    );

    const comparison = workspace.compare(authority(), changed);
    expect(comparison).toMatchObject({
      kind: 'dirty',
      reasons: ['shared-config', 'host-local-content'],
    });
    if (comparison.kind !== 'dirty') throw new Error('expected dirty');
    expect(comparison.current.hostLocalPayloads[0]!.payload).toMatchObject({ secret: 'changed-body' });
  });

  it('Room authority 被 Proposal 改变而 host working copy 未同步时不静默覆盖', () => {
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authority(), bundle());

    const comparison = workspace.compare(authority('成员建议已接受'), bundle());
    expect(comparison).toMatchObject({
      kind: 'dirty',
      reasons: ['shared-config'],
      current: { sharedConfig: { userGuidance: '' } },
    });
  });

  it('仅在已捕获 baseline 仍对应同一权威 revision 时允许自动发布', () => {
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authority(), bundle());
    const localChange = bundle(
      { name: '本地角色', secret: 'changed-body' },
      `sha256:${'b'.repeat(64)}`,
      '房主本地修改',
    );

    expect(workspace.canAutoPublish(authority(), localChange)).toBe(true);
    expect(workspace.canAutoPublish(authority('', { revision: 4 }), localChange)).toBe(false);
    expect(workspace.canAutoPublish(authority('', { roomEpoch: 'epoch-2' }), localChange)).toBe(false);
  });

  it('缺少当前 room/epoch/owner baseline 时 host-local 按房间启动 fail closed', () => {
    const workspace = createArenaRoomHostWorkspace();
    const comparison = workspace.compare(authority(), bundle());
    expect(comparison).toMatchObject({
      kind: 'dirty',
      reasons: ['baseline-missing'],
    });

    workspace.capturePublished(authority(), bundle());
    workspace.retainFor(authority('', { roomEpoch: 'epoch-2' }));
    expect(workspace.compare(authority('', { roomEpoch: 'epoch-2' }), bundle()))
      .toMatchObject({ kind: 'dirty', reasons: ['baseline-missing'] });
  });

  it('没有 host-local ref 时不需要内存 baseline 也可安全启动', () => {
    const workspace = createArenaRoomHostWorkspace();
    const config = {
      ...sharedConfig(),
      combatants: [{
        key: 'data-card:online-1',
        ref: { id: 'online-1', kind: 'character' as const, versionToken: 'v1' },
      }],
    };
    const onlineBundle: ArenaRoomHostWorkspaceBundle = {
      sharedConfig: config,
      hostLocalPayloads: [],
      hostLocalContentDigests: [],
    };
    const comparison = workspace.compare(authority('', { sharedConfig: config }), onlineBundle);
    expect(comparison).toMatchObject({ kind: 'clean', start: { hostLocalPayloads: [] } });
  });

  it('settledAuthority 跟随最近一次 capture，并在 epoch 变化清空 baseline 时归零', () => {
    const workspace = createArenaRoomHostWorkspace();
    expect(workspace.settledAuthority()).toBeNull();

    workspace.capturePublished(authority(), bundle());
    expect(workspace.settledAuthority()).toMatchObject({
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      revision: 3,
      ownerUserId: 'host-1',
    });

    workspace.capturePublished(authority('', { revision: 4 }), bundle());
    expect(workspace.settledAuthority()).toMatchObject({ revision: 4 });

    workspace.retainFor(authority('', { roomEpoch: 'epoch-2' }));
    expect(workspace.settledAuthority()).toBeNull();
  });

  it('working copy 无法投影时仍可从已发布 baseline 取得 Room 启动输入', () => {
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authority(), bundle());
    expect(workspace.startFromRoom(authority())).toMatchObject({
      sharedConfig: { combatants: [{ contentVersion: `sha256:${'a'.repeat(64)}` }] },
      hostLocalPayloads: [{ payload: { secret: 'baseline-body' } }],
    });
    expect(workspace.startFromRoom(authority('', { roomEpoch: 'epoch-other' }))).toBeNull();
  });
});


describe('在线数据卡 latest 发布基线', () => {
  it('接受仅 token 变化的权威，同时拒绝其他配置差异', () => {
    const workspace = createArenaRoomHostWorkspace();
    const local = {
      ...bundle(),
      sharedConfig: {
        ...sharedConfig(),
        combatants: [{ key: 'data-card:online-1', ref: { id: 'online-1', kind: 'character' as const, versionToken: 'v1' } }],
      },
      hostLocalPayloads: [],
      hostLocalContentDigests: [],
    };
    const published = authority('', { sharedConfig: {
      ...local.sharedConfig,
      combatants: [{ key: 'data-card:online-1', ref: { id: 'online-1', kind: 'character', versionToken: 'v2' } }],
    } });
    expect(() => workspace.capturePublished(published, local)).not.toThrow();
    expect(workspace.compare(published, local).kind).toBe('clean');
    expect(workspace.startFromRoom(published)?.sharedConfig).toEqual(published.sharedConfig);
    expect(() => workspace.capturePublished(published, {
      ...local, sharedConfig: { ...local.sharedConfig, userGuidance: 'changed' },
    })).toThrow('ARENA_ROOM_HOST_WORKSPACE_AUTHORITY_MISMATCH');
  });
});


describe('工作区宿主无关边界', () => {
  it.each([
    { roomId: 'room-2' },
    { roomEpoch: 'epoch-2' },
    { ownerUserId: 'host-2' },
  ])('房间、epoch 或 owner 改变时不会复用本地正文基线：%j', (changed) => {
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authority(), bundle());
    const next = authority('', changed);
    expect(workspace.startFromRoom(next)).toBeNull();
    expect(workspace.canAutoPublish(next, bundle())).toBe(false);
    expect(workspace.compare(next, bundle())).toMatchObject({
      kind: 'dirty', reasons: ['baseline-missing'],
    });
    workspace.retainFor(next);
    expect(workspace.settledAuthority()).toBeNull();
  });

  it('保留同 owner 的新 revision 供显式比较，但不允许自动发布覆盖新权威', () => {
    const workspace = createArenaRoomHostWorkspace();
    const captured = authority();
    workspace.capturePublished(captured, bundle());
    const newer = authority('', { revision: 4 });
    workspace.retainFor(newer);
    expect(workspace.settledAuthority()).toEqual(captured);
    expect(workspace.canAutoPublish(newer, bundle())).toBe(false);
    expect(workspace.startFromRoom(newer)?.hostLocalPayloads).toEqual(bundle().hostLocalPayloads);
    workspace.clear();
    expect(workspace.settledAuthority()).toBeNull();
    expect(workspace.startFromRoom(newer)).toBeNull();
  });

  it('输入和取回的本地正文副本不能改写已发布基线', () => {
    const workspace = createArenaRoomHostWorkspace();
    const body = { name: '角色', nested: { value: 'original' } };
    const input = bundle(body);
    workspace.capturePublished(authority(), input);
    body.nested.value = 'input-edited';
    const start = workspace.startFromRoom(authority())!;
    expect((start.hostLocalPayloads[0]!.payload as typeof body).nested).toEqual({ value: 'original' });
    (start.hostLocalPayloads[0]!.payload as typeof body).nested.value = 'output-edited';
    start.sharedConfig.userGuidance = 'output-edited';
    expect(workspace.startFromRoom(authority())).toMatchObject({
      sharedConfig: { userGuidance: '' },
      hostLocalPayloads: [{ payload: { nested: { value: 'original' } } }],
    });
  });

  it.each([
    ['缺少正文', (input: ArenaRoomHostWorkspaceBundle) => ({ ...input, hostLocalPayloads: [] })],
    ['重复正文', (input: ArenaRoomHostWorkspaceBundle) => ({
      ...input, hostLocalPayloads: [...input.hostLocalPayloads, input.hostLocalPayloads[0]!],
    })],
    ['额外正文', (input: ArenaRoomHostWorkspaceBundle) => ({
      ...input, hostLocalPayloads: [...input.hostLocalPayloads, {
        ...input.hostLocalPayloads[0]!, key: 'host-local:character:extra',
      }],
    })],
    ['正文种类不符', (input: ArenaRoomHostWorkspaceBundle) => ({
      ...input, hostLocalPayloads: [{ ...input.hostLocalPayloads[0]!, kind: 'scenario' as const }],
    })],
    ['缺少摘要', (input: ArenaRoomHostWorkspaceBundle) => ({ ...input, hostLocalContentDigests: [] })],
    ['重复摘要', (input: ArenaRoomHostWorkspaceBundle) => ({
      ...input, hostLocalContentDigests: [...input.hostLocalContentDigests, input.hostLocalContentDigests[0]!],
    })],
    ['额外摘要', (input: ArenaRoomHostWorkspaceBundle) => ({
      ...input, hostLocalContentDigests: [...input.hostLocalContentDigests, {
        key: 'host-local:character:extra', digest: `sha256:${'a'.repeat(64)}`,
      }],
    })],
    ['无效摘要', (input: ArenaRoomHostWorkspaceBundle) => ({
      ...input, hostLocalContentDigests: [{ ...input.hostLocalContentDigests[0]!, digest: 'unverified' }],
    })],
  ] as const)('%s 不替换基线，也不允许自动发布', (_label, change) => {
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authority(), bundle());
    const invalid = change(bundle());
    expect(() => workspace.capturePublished(authority(), invalid)).toThrow();
    expect(() => workspace.compare(authority(), invalid)).toThrow();
    expect(workspace.canAutoPublish(authority(), invalid)).toBe(false);
    expect(workspace.startFromRoom(authority())?.hostLocalPayloads).toEqual(bundle().hostLocalPayloads);
  });

  it('latest token 观察只标记当前已捕获 revision 的刷新需求', () => {
    const workspace = createArenaRoomHostWorkspace();
    const onlineConfig = (versionToken: string) => ({
      ...sharedConfig(),
      combatants: [{
        key: 'data-card:online-1',
        ref: { id: 'online-1', kind: 'character' as const, versionToken },
      }],
    });
    const local = { sharedConfig: onlineConfig('v1'), hostLocalPayloads: [], hostLocalContentDigests: [] };
    const latest = authority('', { sharedConfig: onlineConfig('v2') });
    workspace.capturePublished(latest, local);
    expect(workspace.needsOnlineRefresh?.(latest)).toBe(true);
    expect(workspace.needsOnlineRefresh?.({ ...latest, revision: 4 })).toBe(false);
    expect(workspace.needsOnlineRefresh?.({ ...latest, ownerUserId: 'host-2' })).toBe(false);
    workspace.capturePublished(latest, { ...local, sharedConfig: latest.sharedConfig });
    expect(workspace.needsOnlineRefresh?.(latest)).toBe(false);
    workspace.retainFor(null);
    expect(workspace.settledAuthority()).toBeNull();
  });

  it('只从既有 host session 投影 authority，成员和离房状态没有房主工作区', () => {
    const host = { userId: 'host-1', role: 'host', displayName: '房主', membershipState: 'active' };
    const session = ArenaRoomSessionResponseSchema.parse({
      protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', self: host,
      snapshot: {
        protocolVersion: 1, schemaVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1',
        revision: 3, controlSeq: 0, sharedConfig: sharedConfig(), members: [host],
        proposals: [], activeGeneration: null,
      },
    });
    expect(arenaRoomHostWorkspaceAuthorityFromSession(session)).toEqual(authority());
    expect(arenaRoomHostWorkspaceAuthorityFromSession({ ...session, self: { ...session.self, role: 'member' } }))
      .toBeNull();
    expect(arenaRoomHostWorkspaceAuthorityFromSession(null)).toBeNull();
  });
});
