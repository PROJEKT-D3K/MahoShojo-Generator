import { describe, expect, it } from 'vitest';
import {
  arenaRoomHostWorkspaceAuthorityFromSession,
  areArenaRoomSharedConfigsExactlyEqual,
  areArenaRoomSharedConfigsSemanticallyEqual,
  createArenaRoomHostWorkspace,
} from '@mahoshojo/multiplayer-core';

import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { buildArenaRoomHostWorkspaceBundleFromBattleState } from '@/lib/arena-room/shared-config';
import * as webWorkspace from '@/lib/arena-room/host-workspace';
import * as webComparison from '@/lib/arena-room/shared-config-equality';

describe('Web Arena Room host workspace shared core', () => {
  it('现有生产入口直接复用同一工厂和 session 投影，不复制工作区实现', () => {
    expect(webWorkspace.createArenaRoomHostWorkspace).toBe(createArenaRoomHostWorkspace);
    expect(webWorkspace.arenaRoomHostWorkspaceAuthorityFromSession)
      .toBe(arenaRoomHostWorkspaceAuthorityFromSession);
  });

  it('保留旧 semantic alias，权威 exact 比较仍是独立入口', () => {
    expect(webWorkspace.areArenaRoomSharedConfigsEqual)
      .toBe(areArenaRoomSharedConfigsSemanticallyEqual);
    expect(webComparison.areArenaRoomSharedConfigsSemanticallyEqual)
      .toBe(areArenaRoomSharedConfigsSemanticallyEqual);
    expect(webComparison.areArenaRoomSharedConfigsExactlyEqual)
      .toBe(areArenaRoomSharedConfigsExactlyEqual);
    expect(webComparison.areArenaRoomSharedConfigsExactlyEqual)
      .not.toBe(webWorkspace.areArenaRoomSharedConfigsEqual);
  });

  it('真实 BattleState 摘要投影进入原 Web 工作区，正文变化不被误判为已发布', async () => {
    const local = {
      type: 'general-character' as const,
      data: { name: '本地角色', nested: { value: 'original-body' } },
      filename: 'local.json', isValid: true, isPreset: false,
    };
    const state = {
      ...useBattleStore.getState(),
      battleMode: 'classic' as const, reportFormat: 'markdown' as const,
      combatants: [local], teams: [],
      scenario: { content: null, fileName: null, isNative: false },
      auxScenarios: [], materials: [],
    };
    const published = await buildArenaRoomHostWorkspaceBundleFromBattleState(state);
    expect(published.hostLocalPayloads).toHaveLength(1);
    expect(published.hostLocalContentDigests).toEqual([{
      key: published.hostLocalPayloads[0]!.key, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    }]);
    const authority = {
      roomId: 'room-1', roomEpoch: 'epoch-1', revision: 3, ownerUserId: 'host-1',
      sharedConfig: published.sharedConfig,
    };
    const workspace = webWorkspace.createArenaRoomHostWorkspace();
    workspace.capturePublished(authority, published);
    expect(workspace.compare(authority, published).kind).toBe('clean');
    expect(workspace.startFromRoom(authority)?.hostLocalPayloads).toEqual(published.hostLocalPayloads);

    const changed = await buildArenaRoomHostWorkspaceBundleFromBattleState({
      ...state, combatants: [{ ...local, data: { ...local.data, nested: { value: 'edited-body' } } }],
    });
    expect(changed.hostLocalContentDigests[0]!.digest).not.toBe(published.hostLocalContentDigests[0]!.digest);
    expect(workspace.compare(authority, changed)).toMatchObject({
      kind: 'dirty', reasons: ['shared-config', 'host-local-content'],
      current: { hostLocalPayloads: [{ payload: { nested: { value: 'edited-body' } } }] },
    });
    expect(workspace.canAutoPublish(authority, changed)).toBe(true);
    expect(workspace.canAutoPublish({ ...authority, revision: 4 }, changed)).toBe(false);
    expect(workspace.startFromRoom(authority)?.hostLocalPayloads).toEqual(published.hostLocalPayloads);
  });

});
