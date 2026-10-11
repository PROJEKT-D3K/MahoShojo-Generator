// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArenaRoomSharedConfigSchema } from '@mahoshojo/contracts/arena-room';
import type {
  ArenaRoomPublishConfigRequest,
  ArenaRoomSessionResponse,
  ArenaRoomSharedConfig,
} from '@mahoshojo/contracts/arena-room';

import {
  useArenaRoomHostReconciliation,
  type ArenaRoomHostReconciliation,
} from '@/components/arena/multiplayer/useArenaRoomHostReconciliation';
import { ArenaRoomReconciliationAbortError, ArenaRoomReconciliationTransientError } from '@/lib/arena-room/host-reconciliation';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import type {
  ArenaRoomConfigPublishResult,
  ArenaRoomController,
  ArenaRoomControllerState,
} from '@/lib/arena-room/controller';
import { createArenaRoomHostWorkspace } from '@/lib/arena-room/host-workspace';
import type {
  ArenaRoomHostWorkspace,
  ArenaRoomHostWorkspaceAuthority,
} from '@/lib/arena-room/host-workspace';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  applyAuthority: vi.fn(async (
    _config: unknown,
    options: { readonly commitIf?: () => boolean },
  ) => {
    if (options.commitIf && !options.commitIf()) {
      throw new Error('房间配置同步期间状态已变化，未覆盖新的本地修改');
    }
  }),
  buildBundle: vi.fn(),
}));

vi.mock('@/lib/arena-room/host-reconciliation', () => ({
  applyArenaRoomAuthorityToBattleStore: mocks.applyAuthority,
  ArenaRoomReconciliationAbortError: class ArenaRoomReconciliationAbortError extends Error {},
  ArenaRoomReconciliationTransientError: class ArenaRoomReconciliationTransientError extends Error {},
}));

vi.mock('@/lib/arena-room/shared-config', () => ({
  buildArenaRoomHostWorkspaceBundleFromBattleState: mocks.buildBundle,
}));

const config = (battleMode: ArenaRoomSharedConfig['battleMode']): ArenaRoomSharedConfig => ({
  battleMode,
  combatants: [{
    key: 'data-card:character-1',
    ref: { id: 'character-1', kind: 'character', versionToken: 'v1' },
  }],
  teams: [],
  scenario: null,
  auxScenarios: [],
  materials: [],
  userGuidance: '',
  storyLength: 'default',
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

const host = {
  userId: 'host-1',
  role: 'host' as const,
  displayName: '房主',
  membershipState: 'active' as const,
};

const stateAt = (revision: number, sharedConfig: ArenaRoomSharedConfig): ArenaRoomControllerState => ({
  phase: 'connected',
  rooms: [],
  session: {
    protocolVersion: 1,
    roomId: 'room-1',
    roomEpoch: 'epoch-1',
    self: host,
    snapshot: {
      protocolVersion: 1,
      schemaVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      revision,
      controlSeq: revision,
      sharedConfig,
      members: [host],
      proposals: [],
      activeGeneration: null,
    },
  },
  notice: null,
  error: null,
  unknownOperation: null,
  proposalOperation: null,
  proposalResultUnknown: false,
  configPublishPending: false,
  configPublishResultUnknown: false,
  generation: {
    mirror: null,
    phase: 'idle',
    status: null,
    authoritativeMarkdown: '',
    markdown: '',
    storyCursor: null,
    gap: null,
    finalAuthoritative: false,
    generationRecordId: null,
    errorCode: null,
    pendingRequestId: null,
    startResultUnknown: false,
  },
});

/** 模拟 proposal.resolved：同 revision、新 session 对象，仅 controlSeq/proposals 变化。 */
const withControlEventAtSameRevision = (
  state: ArenaRoomControllerState,
  controlSeq: number,
): ArenaRoomControllerState => ({
  ...state,
  session: state.session ? {
    ...state.session,
    snapshot: {
      ...state.session.snapshot,
      controlSeq,
      proposals: [{
        proposalVersion: 1,
        proposalId: `proposal-${controlSeq}`,
        roomId: state.session.roomId,
        authorUserId: 'member-1',
        baseRevision: state.session.snapshot.revision,
        status: 'submitted',
        changes: [],
        createdAt: '2026-09-04T00:00:00.000Z',
      }],
    },
  } : null,
});

const bundle = (sharedConfig: ArenaRoomSharedConfig) => ({
  sharedConfig,
  hostLocalPayloads: [],
  hostLocalContentDigests: [],
});

const authorityOf = (state: ArenaRoomControllerState): ArenaRoomHostWorkspaceAuthority => ({
  roomId: 'room-1',
  roomEpoch: 'epoch-1',
  revision: state.session!.snapshot.revision,
  ownerUserId: 'host-1',
  sharedConfig: state.session!.snapshot.sharedConfig,
});

let container: HTMLDivElement;
let root: Root;
let currentState: ArenaRoomControllerState;
let latest: ArenaRoomHostReconciliation | null;

const publishConfig = vi.fn(
  (_request: ArenaRoomPublishConfigRequest): Promise<ArenaRoomConfigPublishResult> =>
    Promise.resolve({ kind: 'confirmed', session: currentState.session! }),
);
const refreshSession = vi.fn((): Promise<ArenaRoomSessionResponse> =>
  Promise.resolve(currentState.session!),
);
const controller = {
  getSnapshot: () => currentState,
  publishConfig,
  refreshSession,
} as unknown as ArenaRoomController;

const Harness = ({
  state,
  workspace,
}: {
  readonly state: ArenaRoomControllerState;
  readonly workspace: ArenaRoomHostWorkspace;
}) => {
  const reconciliation = useArenaRoomHostReconciliation({
    controller,
    controllerState: state,
    hostWorkspace: workspace,
    retryDelayMs: 0,
  });
  useEffect(() => {
    latest = reconciliation;
  }, [reconciliation]);
  return <span>{reconciliation.state.kind}</span>;
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** 自动重试使用 setTimeout(0)（宏任务），flush 的微任务排空覆盖不到。 */
const flushWithMacrotasks = async () => {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await Promise.resolve();
      await Promise.resolve();
    });
  }
};

const renderState = async (state: ArenaRoomControllerState, workspace: ArenaRoomHostWorkspace) => {
  currentState = state;
  await act(async () => root.render(<Harness state={state} workspace={workspace} />));
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  currentState = stateAt(1, config('classic'));
  latest = null;
  vi.resetAllMocks();
  mocks.applyAuthority.mockImplementation(async (
    _config: unknown,
    options: { readonly commitIf?: () => boolean },
  ) => {
    if (options.commitIf && !options.commitIf()) {
      throw new Error('房间配置同步期间状态已变化，未覆盖新的本地修改');
    }
  });
  publishConfig.mockImplementation(async () => ({ kind: 'confirmed', session: currentState.session! }));
  refreshSession.mockImplementation(async () => currentState.session!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('useArenaRoomHostReconciliation', () => {
  it('首次观察 authority 只记录，不自动覆盖本地', async () => {
    const workspace = {
      settledAuthority: vi.fn(() => null),
      compare: vi.fn(),
      startFromRoom: vi.fn(),
      capturePublished: vi.fn(),
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;

    await renderState(currentState, workspace);
    await flush();

    expect(workspace.compare).not.toHaveBeenCalled();
    expect(mocks.applyAuthority).not.toHaveBeenCalled();
    expect(latest?.state).toMatchObject({ kind: 'idle' });
  });

  it('accepted authority 到达且相对 settled baseline clean 时自动同步并 capture 新 baseline', async () => {
    const settled = authorityOf(stateAt(1, config('classic')));
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('daily')));

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();

    expect(workspace.compare).toHaveBeenCalledOnce();
    expect(workspace.compare).toHaveBeenCalledWith(settled, expect.anything());
    expect(mocks.applyAuthority).toHaveBeenCalledWith(config('daily'), expect.objectContaining({
      hostLocalPayloads: [],
    }));
    expect(capturePublished).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({
      kind: 'synced',
      revision: 2,
    });
  });

  it('本地相对 settled baseline 有真实修改时进入 conflict，不覆盖任一方向', async () => {
    const settled = authorityOf(stateAt(1, config('classic')));
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({
        kind: 'dirty',
        reasons: ['shared-config'] as const,
        current: { sharedConfig: config('classic'), hostLocalPayloads: [] },
      })),
      startFromRoom: vi.fn(),
      capturePublished: vi.fn(),
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockResolvedValue(bundle(config('classic')));

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();

    expect(workspace.compare).toHaveBeenCalledWith(settled, expect.anything());
    expect(mocks.applyAuthority).not.toHaveBeenCalled();
    expect(workspace.capturePublished).not.toHaveBeenCalled();
    expect(latest?.state).toMatchObject({
      kind: 'conflicted',
      revision: 2,
      reasons: ['shared-config'],
    });
  });

  it('proposal.resolved 同 revision session 更新不取消进行中的物化（回归：永久 synchronizing）', async () => {
    const settled = authorityOf(stateAt(1, config('classic')));
    let releaseApply!: () => void;
    const applyPending = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let capturedCommitIf: (() => boolean) | undefined;
    mocks.applyAuthority.mockImplementationOnce(async (_config, options) => {
      capturedCommitIf = options.commitIf;
      await applyPending;
      if (options.commitIf && !options.commitIf()) {
        throw new Error('房间配置同步期间状态已变化，未覆盖新的本地修改');
      }
    });
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('daily')));

    const revision2 = stateAt(2, config('daily'));
    await renderState(currentState, workspace);
    await renderState(revision2, workspace);
    await flush();
    expect(capturedCommitIf).toBeTypeOf('function');

    // 服务端接受提案后会紧随 room.config.updated 发出 proposal.resolved：
    // session 对象替换，但 revision 不变，物化不得被取消。
    await renderState(withControlEventAtSameRevision(revision2, 3), workspace);
    await flush();
    expect(mocks.applyAuthority).toHaveBeenCalledOnce();

    releaseApply();
    await flush();

    expect(capturePublished).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({
      kind: 'synced',
      revision: 2,
    });
  });

  it('连续 authority revision 且房主无本地编辑时直接收敛到最新 revision，不产生伪冲突', async () => {
    const settled = authorityOf(stateAt(1, config('classic')));
    let releaseApply!: () => void;
    const applyPending = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let capturedCommitIf: (() => boolean) | undefined;
    mocks.applyAuthority.mockImplementationOnce(async (_config, options) => {
      capturedCommitIf = options.commitIf;
      await applyPending;
      if (options.commitIf && !options.commitIf()) {
        throw new Error('房间配置同步期间状态已变化，未覆盖新的本地修改');
      }
    });
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('scenario'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('scenario')));

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();
    expect(capturedCommitIf).toBeTypeOf('function');

    await renderState(stateAt(3, config('scenario')), workspace);
    await flush();
    // rev2 的物化被废弃：commitIf 判定过期，不 capture 过期 baseline
    expect(capturedCommitIf?.()).toBe(false);

    releaseApply();
    await flush();

    expect(workspace.compare).toHaveBeenCalledTimes(2);
    expect(workspace.compare).toHaveBeenNthCalledWith(2, settled, expect.anything());
    expect(capturePublished).toHaveBeenCalledOnce();
    expect(capturePublished).toHaveBeenCalledWith(
      authorityOf(stateAt(3, config('scenario'))),
      expect.anything(),
    );
    expect(latest?.state).toMatchObject({
      kind: 'synced',
      revision: 3,
    });
  });

  it('无 settled 基线时退回与上一个观察 authority 比较的保守行为', async () => {
    const observedFirst = authorityOf(stateAt(1, config('classic')));
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => null),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('daily')));

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();

    expect(workspace.compare).toHaveBeenCalledOnce();
    expect(workspace.compare).toHaveBeenCalledWith(observedFirst, expect.anything());
    expect(capturePublished).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
  });

  it('自动同步失败时返回稳定的 reconciliation code，不依赖文案判断', async () => {
    const workspace = {
      settledAuthority: vi.fn(() => null),
      compare: vi.fn(),
      startFromRoom: vi.fn(),
      capturePublished: vi.fn(),
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockRejectedValueOnce(new Error('本地草稿无法读取'));

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();

    expect(latest?.state).toMatchObject({
      kind: 'error',
      code: 'ROOM_GENERATION_RECONCILIATION_REQUIRED',
      message: '本地草稿无法读取',
    });
  });

  it('手动发布被明确拒绝时保留草稿，不自动回退到缓存同步', async () => {
    const settledRev1 = authorityOf(stateAt(1, config('classic')));
    let settled: ArenaRoomHostWorkspaceAuthority | null = settledRev1;
    const capturePublished = vi.fn((authority: ArenaRoomHostWorkspaceAuthority) => {
      settled = authority;
    });
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockResolvedValue(bundle(config('daily')));
    mocks.applyAuthority
      .mockRejectedValueOnce(new Error('公开数据卡暂时无法读取'))
      .mockResolvedValueOnce(undefined);
    publishConfig.mockResolvedValueOnce({ kind: 'rejected', error: new Error('ROOM_CONFLICT: 房间配置已发生变化') });

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();

    expect(latest?.state).toMatchObject({ kind: 'error' });
    expect(mocks.applyAuthority).toHaveBeenCalledTimes(1);
    const compareCallsBeforePublish = workspace.compare.mock.calls.length;
    expect(capturePublished).not.toHaveBeenCalled();

    // 已知拒绝必须保留 draft，不能借 finally 自动用旧缓存重新对账。
    await act(async () => { await latest!.publishLocal(); });
    await flush();

    expect(workspace.compare).toHaveBeenCalledTimes(compareCallsBeforePublish);
    expect(mocks.applyAuthority).toHaveBeenCalledTimes(1);
    expect(capturePublished).not.toHaveBeenCalled();
    expect(latest?.state).toMatchObject({ kind: 'error', message: 'ROOM_CONFLICT: 房间配置已发生变化' });
  });

  it('发布结果未知时保留未知错误，不捕获成功或自动同步缓存', async () => {
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => authorityOf(currentState)),
      compare: vi.fn(),
      startFromRoom: vi.fn(),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockResolvedValue(bundle(config('daily')));
    publishConfig.mockResolvedValueOnce({ kind: 'unknown', error: new Error('请求可能已提交，结果未知') });

    await renderState(stateAt(1, config('classic')), workspace);
    await act(async () => { await latest!.publishLocal(); });

    expect(publishConfig).toHaveBeenCalledOnce();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(mocks.applyAuthority).not.toHaveBeenCalled();
    expect(capturePublished).not.toHaveBeenCalled();
    expect(latest?.state).toMatchObject({ kind: 'error', message: '请求可能已提交，结果未知' });
  });

  it('reconciliation error 后可通过 syncRoom 重试同一 revision（回归：error 恢复入口）', async () => {
    const settledRev1 = authorityOf(stateAt(1, config('classic')));
    let settled: ArenaRoomHostWorkspaceAuthority | null = settledRev1;
    const capturePublished = vi.fn((authority: ArenaRoomHostWorkspaceAuthority) => {
      settled = authority;
    });
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockResolvedValue(bundle(config('daily')));
    mocks.applyAuthority.mockRejectedValueOnce(new Error('公开数据卡暂时无法读取'));

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();

    expect(latest?.state).toMatchObject({ kind: 'error' });
    expect(mocks.applyAuthority).toHaveBeenCalledTimes(1);

    currentState = stateAt(2, config('daily'));
    refreshSession.mockImplementationOnce(async () => currentState.session!);
    await act(async () => { await latest!.syncRoom(); });
    await flush();

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(mocks.applyAuthority).toHaveBeenCalledTimes(2);
    expect(capturePublished).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
  });

  it('syncRoom 先读取最新 session，再将最新 authority 同步到编辑区', async () => {
    const freshState = stateAt(2, config('daily'));
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => authorityOf(currentState)),
      compare: vi.fn(),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle
      .mockResolvedValueOnce(bundle(config('classic')))
      .mockResolvedValueOnce(bundle(config('daily')));
    refreshSession.mockImplementationOnce(async () => {
      currentState = freshState;
      return freshState.session!;
    });

    await renderState(stateAt(1, config('classic')), workspace);
    await act(async () => { await latest!.syncRoom(); });

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(mocks.applyAuthority).toHaveBeenCalledWith(config('daily'), expect.anything());
    expect(capturePublished).toHaveBeenCalledWith(authorityOf(freshState), expect.anything());
    expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
  });

  it('syncRoom 的 fresh GET 失败时不物化缓存 authority，也不自动再次同步', async () => {
    const workspace = {
      settledAuthority: vi.fn(() => null),
      compare: vi.fn(),
      startFromRoom: vi.fn(),
      capturePublished: vi.fn(),
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    refreshSession.mockRejectedValueOnce(new Error('读取房间状态失败'));

    await renderState(stateAt(1, config('classic')), workspace);
    await act(async () => { await latest!.syncRoom(); });
    await flush();

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(mocks.applyAuthority).not.toHaveBeenCalled();
    expect(workspace.capturePublished).not.toHaveBeenCalled();
    expect(latest?.state).toMatchObject({ kind: 'error', message: '读取房间状态失败' });
  });

  it('fresh GET 期间本地编辑变化时中止物化并保留编辑', async () => {
    const previousLanguage = useBattleStore.getState().selectedLanguage;
    let resolveRefresh!: (session: NonNullable<ArenaRoomControllerState['session']>) => void;
    const refreshPending = new Promise<NonNullable<ArenaRoomControllerState['session']>>((resolve) => {
      resolveRefresh = resolve;
    });
    const workspace = {
      settledAuthority: vi.fn(() => null),
      compare: vi.fn(),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished: vi.fn(),
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    refreshSession.mockReturnValueOnce(refreshPending);

    try {
      await renderState(stateAt(1, config('classic')), workspace);
      let syncing!: Promise<void>;
      await act(async () => { syncing = latest!.syncRoom(); await Promise.resolve(); });
      await act(async () => {
        useBattleStore.setState({ selectedLanguage: 'en-US' });
      });
      resolveRefresh(stateAt(2, config('daily')).session!);
      await act(async () => { await syncing; });

      expect(mocks.applyAuthority).not.toHaveBeenCalled();
      expect(workspace.capturePublished).not.toHaveBeenCalled();
      expect(useBattleStore.getState().selectedLanguage).toBe('en-US');
      expect(latest?.state).toMatchObject({ kind: 'error', message: expect.stringContaining('本地内容已变化') });
    } finally {
      await act(async () => { useBattleStore.setState({ selectedLanguage: previousLanguage }); });
    }
  });

  it('发布 bundle 期间 controlSeq 前进时使用最新 controlSeq，不重用旧 fence', async () => {
    let resolveBundle!: (value: ReturnType<typeof bundle>) => void;
    const bundlePending = new Promise<ReturnType<typeof bundle>>((resolve) => { resolveBundle = resolve; });
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => authorityOf(currentState)),
      compare: vi.fn(),
      startFromRoom: vi.fn(),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockReturnValueOnce(bundlePending);
    publishConfig.mockImplementationOnce(async (request) => {
      expect(request.expectedRevision).toBe(1);
      expect(request.expectedControlSeq).toBe(7);
      const published = stateAt(2, config('daily'));
      published.session!.snapshot.controlSeq = 8;
      currentState = published;
      return { kind: 'confirmed', session: published.session! };
    });

    await renderState(stateAt(1, config('classic')), workspace);
    let publishing!: Promise<void>;
    await act(async () => { publishing = latest!.publishLocal(); await Promise.resolve(); });
    currentState = withControlEventAtSameRevision(currentState, 7);
    resolveBundle(bundle(config('daily')));
    await act(async () => { await publishing; });

    expect(publishConfig).toHaveBeenCalledOnce();
    expect(capturePublished).toHaveBeenCalledWith(authorityOf(currentState), expect.anything());
    expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
  });

  it('发布 bundle 期间 revision 前进时拒绝旧草稿且不发请求', async () => {
    let resolveBundle!: (value: ReturnType<typeof bundle>) => void;
    const bundlePending = new Promise<ReturnType<typeof bundle>>((resolve) => { resolveBundle = resolve; });
    const workspace = {
      settledAuthority: vi.fn(() => authorityOf(currentState)),
      compare: vi.fn(),
      startFromRoom: vi.fn(),
      capturePublished: vi.fn(),
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockReturnValueOnce(bundlePending);

    await renderState(stateAt(1, config('classic')), workspace);
    let publishing!: Promise<void>;
    await act(async () => { publishing = latest!.publishLocal(); await Promise.resolve(); });
    currentState = stateAt(2, config('scenario'));
    resolveBundle(bundle(config('daily')));
    await act(async () => { await publishing; });

    expect(publishConfig).not.toHaveBeenCalled();
    expect(workspace.capturePublished).not.toHaveBeenCalled();
    expect(latest?.state).toMatchObject({ kind: 'error', message: expect.stringContaining('房间权威状态已变化') });
  });

  it('物化期间无关 BattleStore 更新不中止 commit（回归：随机匹配公开角色后房主工作区卡在半同步）', async () => {
    const settled = authorityOf(stateAt(1, config('classic')));
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    let releaseApply!: () => void;
    const applyPending = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let capturedCommitIf: (() => boolean) | undefined;
    mocks.applyAuthority.mockImplementationOnce(async (_config, options) => {
      capturedCommitIf = options.commitIf;
      await applyPending;
      if (options.commitIf && !options.commitIf()) {
        throw new Error('房间配置同步期间状态已变化，未覆盖新的本地修改');
      }
    });
    mocks.buildBundle.mockResolvedValue(bundle(config('daily')));

    const previousError = useBattleStore.getState().error;
    try {
      await renderState(currentState, workspace);
      await renderState(stateAt(2, config('daily')), workspace);
      await flush();
      expect(capturedCommitIf).toBeTypeOf('function');

      // 在线数据卡异步加载期间（如随机匹配到的公开角色），无关 store 更新发生：
      await act(async () => {
        useBattleStore.setState({ error: 'unrelated-update-canary' });
      });
      expect(capturedCommitIf?.()).toBe(true);

      releaseApply();
      await flush();

      expect(mocks.applyAuthority).toHaveBeenCalledOnce();
      expect(capturePublished).toHaveBeenCalledOnce();
      expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
    } finally {
      await act(async () => {
        useBattleStore.setState({ error: previousError });
      });
    }
  });

  it('物化期间共享配置相关字段变化时 fence 中止，重试后自动收敛', async () => {
    const settled = authorityOf(stateAt(1, config('classic')));
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    let releaseApply!: () => void;
    const applyPending = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let capturedCommitIf: (() => boolean) | undefined;
    mocks.applyAuthority.mockImplementationOnce(async (_config, options) => {
      capturedCommitIf = options.commitIf;
      await applyPending;
      if (options.commitIf && !options.commitIf()) {
        throw new ArenaRoomReconciliationAbortError('房间配置同步期间状态已变化，未覆盖新的本地修改');
      }
    });
    mocks.buildBundle.mockResolvedValue(bundle(config('daily')));

    const previousLanguage = useBattleStore.getState().selectedLanguage;
    try {
      await renderState(currentState, workspace);
      await renderState(stateAt(2, config('daily')), workspace);
      await flush();
      expect(capturedCommitIf).toBeTypeOf('function');

      await act(async () => {
        useBattleStore.setState({ selectedLanguage: 'en-US' });
      });
      expect(capturedCommitIf?.()).toBe(false);

      releaseApply();
      // attempt 1 因 fence 中止 → 自动重试同一 revision → 收敛
      await flushWithMacrotasks();

      expect(mocks.applyAuthority).toHaveBeenCalledTimes(2);
      expect(capturePublished).toHaveBeenCalledOnce();
      expect(capturePublished).toHaveBeenCalledWith(
        authorityOf(stateAt(2, config('daily'))),
        expect.anything(),
      );
      expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
    } finally {
      await act(async () => {
        useBattleStore.setState({ selectedLanguage: previousLanguage });
      });
    }
  });

  it('在线数据卡暂时读取失败时自动重试同一 revision 并收敛（回归：服务器已接受、房主工作区仍旧）', async () => {
    const settled = authorityOf(stateAt(1, config('classic')));
    const capturePublished = vi.fn();
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockResolvedValue(bundle(config('daily')));
    mocks.applyAuthority
      .mockRejectedValueOnce(new ArenaRoomReconciliationTransientError('公开数据卡 card-1 暂时无法读取'))
      .mockResolvedValueOnce(undefined);

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();
    await flushWithMacrotasks();

    expect(mocks.applyAuthority).toHaveBeenCalledTimes(2);
    expect(capturePublished).toHaveBeenCalledOnce();
    expect(capturePublished).toHaveBeenCalledWith(
      authorityOf(stateAt(2, config('daily'))),
      expect.anything(),
    );
    expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
  });

  it('自动重试耗尽后保持 error，手动 syncRoom 仍可恢复同一 revision', async () => {
    const settledRev1 = authorityOf(stateAt(1, config('classic')));
    let settled: ArenaRoomHostWorkspaceAuthority | null = settledRev1;
    const capturePublished = vi.fn((authority: ArenaRoomHostWorkspaceAuthority) => {
      settled = authority;
    });
    const workspace = {
      settledAuthority: vi.fn(() => settled),
      compare: vi.fn(() => ({ kind: 'clean', start: { sharedConfig: config('classic'), hostLocalPayloads: [] } })),
      startFromRoom: vi.fn(() => ({ sharedConfig: config('daily'), hostLocalPayloads: [] })),
      capturePublished,
      retainFor: vi.fn(),
      clear: vi.fn(),
    } satisfies ArenaRoomHostWorkspace;
    mocks.buildBundle.mockResolvedValue(bundle(config('daily')));
    mocks.applyAuthority
      .mockRejectedValueOnce(new ArenaRoomReconciliationTransientError('公开数据卡 card-1 暂时无法读取'))
      .mockRejectedValueOnce(new ArenaRoomReconciliationTransientError('公开数据卡 card-1 暂时无法读取'))
      .mockRejectedValueOnce(new ArenaRoomReconciliationTransientError('公开数据卡 card-1 暂时无法读取'))
      .mockResolvedValueOnce(undefined);

    await renderState(currentState, workspace);
    await renderState(stateAt(2, config('daily')), workspace);
    await flush();
    await flushWithMacrotasks();

    expect(mocks.applyAuthority).toHaveBeenCalledTimes(3);
    expect(latest?.state).toMatchObject({
      kind: 'error',
      message: '公开数据卡 card-1 暂时无法读取',
    });

    await act(async () => { await latest!.syncRoom(); });
    await flush();

    expect(mocks.applyAuthority).toHaveBeenCalledTimes(4);
    expect(capturePublished).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({ kind: 'synced', revision: 2 });
  });
});


describe('发布成功后的 latest 正文刷新', () => {
  const oldConfig = () => ArenaRoomSharedConfigSchema.parse(config('classic'));
  const latestConfig = (): ArenaRoomSharedConfig => ({
    ...oldConfig(),
    combatants: [{ key: 'data-card:character-1', ref: { id: 'character-1', kind: 'character', versionToken: 'v2' } }],
  });

  it('首次观察已发布的 token drift 自动刷新，加载后不会循环同步', async () => {
    const published = stateAt(1, latestConfig());
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authorityOf(published), bundle(oldConfig()));
    mocks.buildBundle.mockResolvedValueOnce(bundle(oldConfig()))
      .mockResolvedValueOnce(bundle(oldConfig()))
      .mockResolvedValue(bundle(latestConfig()));
    await renderState(published, workspace);
    await flush();
    expect(mocks.applyAuthority).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({ kind: 'synced', revision: 1 });
    await renderState(withControlEventAtSameRevision(published, 2), workspace);
    await flush();
    expect(mocks.applyAuthority).toHaveBeenCalledOnce();
  });

  it('创建 session 先于发布基线出现时，可在 capture 后补一次自动刷新', async () => {
    const published = stateAt(1, latestConfig());
    const workspace = createArenaRoomHostWorkspace();
    mocks.buildBundle.mockResolvedValueOnce(bundle(oldConfig()))
      .mockResolvedValueOnce(bundle(oldConfig()))
      .mockResolvedValue(bundle(latestConfig()));
    await renderState(published, workspace);
    await flush();
    expect(mocks.applyAuthority).not.toHaveBeenCalled();
    workspace.capturePublished(authorityOf(published), bundle(oldConfig()));
    await act(async () => latest?.reconcilePublished());
    await flush();
    expect(mocks.applyAuthority).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({ kind: 'synced' });
  });

  it('异步对账构建期间用户编辑时重新判断冲突，不覆盖新编辑', async () => {
    const published = stateAt(1, latestConfig());
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authorityOf(published), bundle(oldConfig()));
    let resolveBundle!: (value: ReturnType<typeof bundle>) => void;
    mocks.buildBundle.mockImplementationOnce(() => new Promise((resolve) => { resolveBundle = resolve; }))
      .mockResolvedValue(bundle({ ...oldConfig(), battleMode: 'daily' }));
    const originalMode = useBattleStore.getState().battleMode;
    try {
      await renderState(published, workspace);
      await act(async () => {
        useBattleStore.setState({ battleMode: originalMode === 'daily' ? 'classic' : 'daily' });
        resolveBundle(bundle(oldConfig()));
      });
      await flushWithMacrotasks();
      expect(mocks.applyAuthority).not.toHaveBeenCalled();
      expect(latest?.state).toMatchObject({ kind: 'conflicted' });
    } finally {
      useBattleStore.setState({ battleMode: originalMode });
    }
  });

  it('正文刷新失败保留发布成功状态，不阻塞后续操作', async () => {
    const published = stateAt(1, latestConfig());
    const workspace = createArenaRoomHostWorkspace();
    workspace.capturePublished(authorityOf(published), bundle(oldConfig()));
    mocks.buildBundle.mockResolvedValue(bundle(oldConfig()));
    mocks.applyAuthority.mockRejectedValueOnce(new Error('读取失败'));
    await renderState(published, workspace);
    await flush();
    expect(latest?.state).toMatchObject({ kind: 'synced', message: expect.stringContaining('房间配置已保存') });
    expect(workspace.compare(authorityOf(published), bundle(oldConfig())).kind).toBe('clean');
  });
});
