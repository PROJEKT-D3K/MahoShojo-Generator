import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import * as authIdentity from '@/lib/auth-identity';

import {
  ArenaRoomClientError,
  type ArenaRoomClient,
} from '@/lib/arena-room/client';
import {
  createArenaRoomController,
  type ArenaRoomSocket,
} from '@/lib/arena-room/controller';

const sharedConfig = {
  battleMode: 'classic' as const,
  reportFormat: 'markdown' as const,
  combatants: [{
    key: 'host-local:character:1',
    displayName: '角色',
    type: 'magical-girl' as const,
    source: 'host-local' as const,
  }],
  teams: [],
  scenario: null,
  auxScenarios: [],
  materials: [],
  userGuidance: '',
  storyLength: 'default' as const,
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
};

const snapshot = {
  protocolVersion: 1 as const,
  schemaVersion: 1 as const,
  roomId: 'room-1',
  roomEpoch: 'epoch-1',
  revision: 0,
  controlSeq: 0,
  sharedConfig,
  members: [{
    userId: 'user-host',
    role: 'host' as const,
    displayName: '房主',
    membershipState: 'active' as const,
  }],
  proposals: [],
  activeGeneration: null,
};

const session = {
  protocolVersion: 1 as const,
  roomId: snapshot.roomId,
  roomEpoch: snapshot.roomEpoch,
  self: snapshot.members[0]!,
  snapshot,
};

const generationMirror = {
  generationRequestId: 'request-12345678',
  generationId: 'generation-1',
  attempt: 1,
  state: 'running' as const,
  configRevision: 0,
  snapshotDigest: 'sha256:generation-snapshot',
  collaborativeInfluence: true,
  participantUserIds: [1],
  startedAt: '2026-08-28T00:01:00.000Z',
};

const generationView = {
  protocolVersion: 1 as const,
  roomId: 'room-1',
  roomEpoch: 'epoch-1',
  generation: generationMirror,
  status: 'running' as const,
  markdown: '权威基线',
  nextChunkSeq: 0,
  finalAuthoritative: false,
};

const generationResult = {
  version: 1 as const,
  format: 'stream-markdown' as const,
  mode: 'classic' as const,
  reporterInfo: { name: '安全记者', publication: '房间日报' },
  sharedGuidance: '保护车站',
  ai: {
    model: 'safe-model-name',
    usage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
  },
  combatantUpdates: [{
    combatantKey: 'host-local:character:1',
    displayName: '角色',
    impact: '守住车站',
    currentStateSummary: '轻伤',
  }],
};

const generationStartRequest = {
  expectedRoomEpoch: 'epoch-1',
  expectedRevision: 0,
  expectedControlSeq: 0,
  generationRequestId: 'request-12345678',
  sharedConfig,
  generation: {
    prompt: '完整生成请求',
    providerCredential: 'test-secret-canary',
  },
};

class FakeSocket implements ArenaRoomSocket {
  protocol = 'mahoshojo.arena-room.presence.v1';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  open() {
    this.onopen?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data });
  }

  closed(code: number, reason = '') {
    this.onclose?.({ code, reason });
  }
}

const ticket = (value: string) => ({
  protocolVersion: 1 as const,
  ticket: value,
  expiresInSeconds: 45,
  websocket: {
    path: '/api/arena/rooms/v1/ws' as const,
    protocol: 'mahoshojo.arena-room.v1' as const,
  },
});

const sendGenerationControlEvent = (
  socket: FakeSocket,
  type: 'generation.started' | 'generation.completed' | 'generation.failed',
  controlSeq: number,
  extraPayload: Record<string, unknown> = {},
): void => {
  socket.message(JSON.stringify({
    protocolVersion: 1,
    roomId: 'room-1',
    roomEpoch: 'epoch-1',
    controlSeq,
    timestamp: `2026-08-28T00:0${controlSeq}:00.000Z`,
    type,
    payload: {
      generationRequestId: generationMirror.generationRequestId,
      generationId: generationMirror.generationId,
      attempt: generationMirror.attempt,
      configRevision: generationMirror.configRevision,
      snapshotDigest: generationMirror.snapshotDigest,
      collaborativeInfluence: generationMirror.collaborativeInfluence,
      participantUserIds: generationMirror.participantUserIds,
      ...extraPayload,
    },
  }));
};

type HarnessOverrides = Partial<Parameters<typeof createArenaRoomController>[0]>;

const createHarness = (overrides: HarnessOverrides = {}) => {
  let ticketIndex = 0;
  let createRequestIndex = 0;
  const client: ArenaRoomClient = {
    discover: vi.fn(async () => ({ items: [], nextCursor: null })),
    create: vi.fn(async () => session),
    join: vi.fn(async () => session),
    getSession: vi.fn(async () => session),
    issueTicket: vi.fn(async () => ticket(`ticket-${++ticketIndex}`)),
    leave: vi.fn(async () => ({ protocolVersion: 1, roomId: 'room-1', outcome: 'left' })),
    close: vi.fn(async () => ({ protocolVersion: 1, roomId: 'room-1', outcome: 'closed' })),
    kick: vi.fn(async () => session),
    submitProposal: vi.fn(async (roomId, request) => ({
      protocolVersion: 1,
      roomId,
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      revision: 0,
      proposalId: request.proposalId,
      status: 'submitted' as const,
      result: 'applied' as const,
    })),
    resolveProposal: vi.fn(async (roomId, proposalId) => ({
      protocolVersion: 1,
      roomId,
      roomEpoch: 'epoch-1',
      // 真实状态机中 accept 在 submit 事件（seq 1）之后还会推进
      // room.config.updated（seq 2）与 proposal.resolved（seq 3）两个控制事件，
      // 响应携带最终 controlSeq 与完整权威 snapshot。
      controlSeq: 3,
      revision: 1,
      proposalId,
      status: 'accepted' as const,
      result: 'applied' as const,
      sharedConfig: { ...sharedConfig, userGuidance: '成员建议' },
      snapshot: {
        ...snapshot,
        controlSeq: 3,
        revision: 1,
        sharedConfig: { ...sharedConfig, userGuidance: '成员建议' },
        proposals: [],
      },
    })),
    withdrawProposal: vi.fn(async (roomId, proposalId) => ({
      protocolVersion: 1,
      roomId,
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      revision: 0,
      proposalId,
      status: 'withdrawn' as const,
      result: 'applied' as const,
    })),
    publishConfig: vi.fn(async () => session),
    startGeneration: vi.fn(async () => generationView),
    listGenerationHistory: vi.fn(async () => ({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      items: [],
    })),
    getGenerationHistoryView: vi.fn(async () => { throw new Error('not used'); }),
    getGenerationView: vi.fn(async () => generationView),
    cancelGeneration: vi.fn(async () => generationView),
    buildWebSocketUrl: vi.fn((issued) => `wss://room.test/ws?ticket=${issued.ticket}`),
  };
  const sockets: FakeSocket[] = [];
  const queued: Array<() => void> = [];
  const recoveryTimeouts: Array<() => void> = [];
  // setTimer 仅用于重连调度，记录每次调度到的延迟即可精确断言退避序列。
  const scheduledDelays: number[] = [];
  const controller = createArenaRoomController({
    client,
    identity: { epoch: 0, isCurrent: () => true },
    createSocket: vi.fn((url, protocol) => {
      expect(url).toMatch(/^wss:\/\/room\.test\/ws\?ticket=ticket-/u);
      expect(protocol).toEqual(['mahoshojo.arena-room.presence.v1', 'mahoshojo.arena-room.v1']);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    initialAccess: { enabled: true, authenticated: true },
    maxReconnectAttempts: 2,
    reconnectDelayMs: () => 0,
    setTimer: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      queued.push(callback);
      return callback;
    },
    clearTimer: (handle) => {
      const index = queued.indexOf(handle as () => void);
      if (index >= 0) queued.splice(index, 1);
    },
    setRecoveryAttemptTimer: (callback) => {
      recoveryTimeouts.push(callback);
      return callback;
    },
    clearRecoveryAttemptTimer: (handle) => {
      const index = recoveryTimeouts.indexOf(handle as () => void);
      if (index >= 0) recoveryTimeouts.splice(index, 1);
    },
    createRequestId: () => `create-request-${String(++createRequestIndex).padStart(4, '0')}`,
    ...overrides,
  });
  const runNextTimer = async () => {
    queued.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  const runNextRecoveryTimeout = async () => {
    recoveryTimeouts.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    client,
    controller,
    queued,
    recoveryTimeouts,
    scheduledDelays,
    runNextTimer,
    runNextRecoveryTimeout,
    sockets,
  };
};

describe('Arena Room browser controller', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('在 randomUUID 缺失时默认房间创建请求仍使用兼容 UUID', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        array.fill(0);
        return array;
      },
    });
    const { client, controller } = createHarness({ createRequestId: undefined });

    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      creationRequestId: '00000000-0000-4000-8000-000000000000',
    }));
  });

  it('disabled/unauthenticated 状态不发任何 Room 请求', async () => {
    const { client, controller } = createHarness();
    controller.setAccess({ enabled: false, authenticated: true });
    await controller.discover();
    controller.setAccess({ enabled: true, authenticated: false });
    await controller.discover();

    expect(client.discover).not.toHaveBeenCalled();
    expect(client.issueTicket).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('unauthenticated');
  });

  it('公开房间发现保留 cursor，加载第二页时有界追加并去重', async () => {
    const { client, controller } = createHarness();
    const room = (roomId: string) => ({
      roomId,
      title: `房间 ${roomId}`,
      visibility: 'public' as const,
      status: 'open' as const,
      createdAt: '2026-08-28T00:00:00.000Z',
      lastActivityAt: '2026-08-28T00:01:00.000Z',
    });
    vi.mocked(client.discover)
      .mockResolvedValueOnce({ items: [room('room-1'), room('room-2')], nextCursor: 'cursor-page-2' })
      .mockResolvedValueOnce({ items: [room('room-2'), room('room-3')], nextCursor: null });

    await controller.discover();
    expect(client.discover).toHaveBeenNthCalledWith(1, { limit: 20 });
    expect(controller.getSnapshot()).toMatchObject({
      rooms: [room('room-1'), room('room-2')],
      directoryNextCursor: 'cursor-page-2',
      directoryLoadingMore: false,
    });

    await controller.discoverMore();
    expect(client.discover).toHaveBeenNthCalledWith(2, { limit: 20, cursor: 'cursor-page-2' });
    expect(controller.getSnapshot()).toMatchObject({
      rooms: [room('room-1'), room('room-2'), room('room-3')],
      directoryNextCursor: null,
      directoryLoadingMore: false,
    });

    await controller.discoverMore();
    expect(client.discover).toHaveBeenCalledTimes(2);
  });

  it('忽略 access/reset 后才返回的旧 HTTP 结果', async () => {
    const first = createHarness();
    let resolveCreate!: (value: typeof session) => void;
    vi.mocked(first.client.create).mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    const creating = first.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    first.controller.setAccess({ enabled: true, authenticated: false });
    resolveCreate(session);
    await creating;

    expect(first.client.issueTicket).not.toHaveBeenCalled();
    expect(first.controller.getSnapshot()).toMatchObject({
      phase: 'unauthenticated',
      session: null,
    });

    const second = createHarness();
    const discoveredRoom = {
      roomId: 'room-stale',
      title: '过期结果',
      visibility: 'public' as const,
      status: 'open' as const,
      createdAt: '2026-08-28T00:00:00.000Z',
      lastActivityAt: '2026-08-28T00:01:00.000Z',
    };
    let resolveDiscovery!: (value: { items: [typeof discoveredRoom]; nextCursor: null }) => void;
    vi.mocked(second.client.discover).mockImplementation(() => new Promise((resolve) => {
      resolveDiscovery = resolve;
    }));
    const discovering = second.controller.discover();
    second.controller.reset();
    resolveDiscovery({ items: [discoveredRoom], nextCursor: null });
    await discovering;
    expect(second.controller.getSnapshot().phase).toBe('ready');
    expect(second.controller.getSnapshot().rooms).toEqual([]);
  });

  it('create 仅提交一次，按 session -> fresh ticket -> WSS 顺序连接', async () => {
    const { client, controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.issueTicket).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe('connecting');
    sockets[0]!.open();
    expect(controller.getSnapshot().phase).toBe('connected');
  });

  it('1013 重连只重取 ticket/cursor，绝不重放 create/join', async () => {
    const { client, controller, runNextTimer, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 4,
      timestamp: '2026-08-28T00:04:00.000Z',
      type: 'room.snapshot',
      payload: { ...snapshot, controlSeq: 4 },
    }));
    sockets[0]!.closed(1013, 'try-again-later');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      notice: '正在重新连接…',
    });
    await runNextTimer();

    expect(client.issueTicket).toHaveBeenCalledTimes(2);
    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', {
      reconnect: { control: { roomEpoch: 'epoch-1', controlSeq: 4 } },
    });
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.join).not.toHaveBeenCalled();
    sockets[1]!.open();
    expect(controller.getSnapshot().phase).toBe('connected');
  });

  it('默认重连延迟叠加 0.8–1.2× 乘性 jitter（RNG 可注入），打散服务重启后的同步重连', async () => {
    const rolls = [0, 0.5, 0.75];
    const { controller, runNextTimer, scheduledDelays, sockets } = createHarness({
      maxReconnectAttempts: 3,
      reconnectDelayMs: undefined,
      reconnectRandom: () => rolls.shift() ?? 0,
    });
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();

    // attempt 1：基线 500ms，roll=0 → 0.8×500 = 400
    sockets[0]!.closed(1013, 'try-again-later');
    expect(scheduledDelays).toEqual([400]);
    await runNextTimer();

    // 跨连接未收到 validated control frame 不重置预算：attempt 2 基线 1000ms，
    // roll=0.5 → 1.0×1000 = 1000
    sockets[1]!.open();
    sockets[1]!.closed(1013, 'try-again-later');
    expect(scheduledDelays).toEqual([400, 1000]);
    await runNextTimer();

    // attempt 3：基线 2000ms，roll=0.75 → 1.1×2000 = 2200
    sockets[2]!.open();
    sockets[2]!.closed(1013, 'try-again-later');
    expect(scheduledDelays).toEqual([400, 1000, 2200]);
  });

  it('注入 reconnectDelayMs 时完全接管延迟，不叠加 jitter', async () => {
    const { controller, runNextTimer, scheduledDelays, sockets } = createHarness({
      reconnectDelayMs: () => 1234,
    });
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.closed(1013, 'try-again-later');
    expect(scheduledDelays).toEqual([1234]);
    await runNextTimer();
    sockets[1]!.open();
    sockets[1]!.closed(1013, 'try-again-later');
    expect(scheduledDelays).toEqual([1234, 1234]);
  });

  it('服务器正常关闭 socket 时立即结束本地房间会话', async () => {
    const { controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();

    sockets[0]!.closed(1000, 'room-closed');

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      notice: '房间已关闭',
      generation: { phase: 'idle', mirror: null },
    });
  });

  it('非房间终态的正常 socket 关闭会重连而不清除 session', async () => {
    const { client, controller, runNextTimer, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();

    sockets[0]!.closed(1000, 'maintenance');

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      session: { roomId: 'room-1', roomEpoch: 'epoch-1' },
    });
    await runNextTimer();
    expect(client.issueTicket).toHaveBeenCalledTimes(2);
  });

  it('room.closing 权威事件立即结束本地房间会话', async () => {
    const { controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();

    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      type: 'room.closing',
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:03:00.000Z',
      payload: { reason: 'closed-by-host' },
    }));

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      notice: '房间已关闭',
    });
  });

  it('自己的 room.member.left 权威事件立即结束本地房间会话', async () => {
    const { client, controller, sockets } = createHarness();
    const self = {
      userId: 'member-1',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    vi.mocked(client.join).mockResolvedValueOnce({
      ...session,
      self,
      snapshot: { ...snapshot, members: [snapshot.members[0]!, self] },
    });
    await controller.join('room-1', '成员');
    sockets[0]!.open();

    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      type: 'room.member.left',
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:03:00.000Z',
      payload: { member: { ...self, membershipState: 'revoked' } },
    }));

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      notice: '房间成员资格已结束',
    });
  });

  it('authoritative snapshot/member events 更新视图但不触发任何 generation/write', async () => {
    const { controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'room.member.joined',
      payload: {
        member: {
          userId: 'user-member',
          role: 'member',
          displayName: '成员',
          membershipState: 'active',
          joinedAt: '2026-08-28T00:01:00.000Z',
        },
      },
    }));

    expect(controller.getSnapshot().session?.snapshot.members).toHaveLength(2);
    expect(sockets[0]!.send).not.toHaveBeenCalled();
  });

  it.each([false, true])('Host resolve 权威响应收敛及 WSS 幂等复制，override=%s', async (override) => {
    const { client, controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const proposal = {
      proposalVersion: 1 as const,
      proposalId: 'proposal-1',
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted' as const,
      changes: [{
        changeId: 'guidance-1',
        type: 'setUserGuidance' as const,
        value: '成员建议',
        expectedBase: { kind: 'value' as const, value: '' },
      }],
      createdAt: '2026-08-28T00:01:00.000Z',
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal },
    }));
    expect(controller.getSnapshot().session?.snapshot.proposals).toEqual([proposal]);

    await controller.resolveProposal('proposal-1', {
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      resolution: 'accept-selected',
      selectedChangeIds: ['guidance-1'],
      ...(override ? { overrideChangeIds: ['guidance-1'] } : {}),
    });
    expect(client.resolveProposal).toHaveBeenCalledWith('room-1', 'proposal-1', {
      expectedRoomEpoch: 'epoch-1', expectedRevision: 0, resolution: 'accept-selected',
      selectedChangeIds: ['guidance-1'], ...(override ? { overrideChangeIds: ['guidance-1'] } : {}),
    });
    expect(client.resolveProposal).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connected',
      proposalOperation: null,
      proposalResultUnknown: false,
      notice: '提案已应用',
    });
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    // 命令响应就是收敛主路径：无需等待 WSS 即可看见提案移除与房间配置更新。
    const installed = controller.getSnapshot().session;
    expect(installed?.snapshot.revision).toBe(1);
    expect(installed?.snapshot.controlSeq).toBe(3);
    expect(installed?.snapshot.sharedConfig).toEqual({ ...sharedConfig, userGuidance: '成员建议' });
    expect(installed?.snapshot.proposals).toEqual([]);

    // 稍后到达的 WSS 复制事件与已安装状态一致，不得回退或重复应用。
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'room.config.updated',
      payload: {
        revision: 1,
        sharedConfig: { ...sharedConfig, userGuidance: '成员建议' },
      },
    }));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 3,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'proposal.resolved',
      payload: { proposalId: 'proposal-1', status: 'accepted' },
    }));
    const afterReplication = controller.getSnapshot().session;
    expect(afterReplication?.snapshot.revision).toBe(1);
    expect(afterReplication?.snapshot.controlSeq).toBe(3);
    expect(afterReplication?.snapshot.sharedConfig).toEqual({ ...sharedConfig, userGuidance: '成员建议' });
    expect(afterReplication?.snapshot.proposals).toEqual([]);
  });

  it('resolve 安装完整权威 snapshot：未送达的中间控制事件内容不丢失', async () => {
    const { client, controller, queued, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const member = {
      userId: 'user-member',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    const proposal = (proposalId: string, changeId: string) => ({
      proposalVersion: 1 as const,
      proposalId,
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted' as const,
      changes: [{
        changeId,
        type: 'setUserGuidance' as const,
        value: `${proposalId} 建议`,
        expectedBase: { kind: 'value' as const, value: '' },
      }],
      createdAt: '2026-08-28T00:01:00.000Z',
    });
    const first = proposal('proposal-1', 'guidance-1');
    const second = proposal('proposal-2', 'guidance-2');
    // 房主只收到了 P1 的提交事件；P2 的提交事件（seq 2）仍在途。
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal: first },
    }));
    expect(controller.getSnapshot().session?.snapshot.proposals).toEqual([first]);

    vi.mocked(client.resolveProposal).mockResolvedValueOnce({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 4,
      revision: 1,
      proposalId: 'proposal-1',
      status: 'accepted' as const,
      result: 'applied' as const,
      sharedConfig: { ...sharedConfig, userGuidance: 'proposal-1 建议' },
      snapshot: {
        ...snapshot,
        controlSeq: 4,
        revision: 1,
        sharedConfig: { ...sharedConfig, userGuidance: 'proposal-1 建议' },
        members: [...snapshot.members, member],
        proposals: [second],
        activeGeneration: null,
      },
    });
    await controller.resolveProposal('proposal-1', {
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      resolution: 'accept-selected',
      selectedChangeIds: ['guidance-1'],
    });

    // 部分安装会只删除 P1 并把 controlSeq 宣布到 4，导致 P2 被去重规则丢弃；
    // 完整权威 snapshot 安装必须保留服务器视角的全部 proposals。
    const installed = controller.getSnapshot().session;
    expect(installed?.snapshot.controlSeq).toBe(4);
    expect(installed?.snapshot.proposals).toEqual([second]);
    expect(installed?.snapshot.sharedConfig).toEqual({ ...sharedConfig, userGuidance: 'proposal-1 建议' });

    // 在途事件随后到达：seq <= 4 全部被去重丢弃，且不得触发重连。
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal: second },
    }));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 3,
      timestamp: '2026-08-28T00:02:30.000Z',
      type: 'room.config.updated',
      payload: {
        revision: 1,
        sharedConfig: { ...sharedConfig, userGuidance: 'proposal-1 建议' },
      },
    }));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 4,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'proposal.resolved',
      payload: { proposalId: 'proposal-1', status: 'accepted' },
    }));
    const after = controller.getSnapshot();
    expect(after.session?.snapshot.controlSeq).toBe(4);
    expect(after.session?.snapshot.proposals).toEqual([second]);
    expect(after.phase).toBe('connected');
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it('resolve 响应落后于本地权威时不回退，等待 WSS 完成 proposal 清理', async () => {
    const { client, controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const proposal = {
      proposalVersion: 1 as const,
      proposalId: 'proposal-1',
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted' as const,
      changes: [{
        changeId: 'guidance-1',
        type: 'setUserGuidance' as const,
        value: '成员建议',
        expectedBase: { kind: 'value' as const, value: '' },
      }],
      createdAt: '2026-08-28T00:01:00.000Z',
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal },
    }));
    const roomConfigAfterResponse = {
      revision: 2,
      sharedConfig: { ...sharedConfig, userGuidance: '更快的权威更新' },
    };
    vi.mocked(client.resolveProposal).mockImplementationOnce(async () => {
      // 响应返回前 WSS 已应用更新的权威 revision（例如并发场景）。
      sockets[0]!.message(JSON.stringify({
        protocolVersion: 1,
        roomId: 'room-1',
        roomEpoch: 'epoch-1',
        controlSeq: 2,
        timestamp: '2026-08-28T00:02:00.000Z',
        type: 'room.config.updated',
        payload: roomConfigAfterResponse,
      }));
      return {
        protocolVersion: 1,
        roomId: 'room-1',
        roomEpoch: 'epoch-1',
        controlSeq: 2,
        revision: 1,
        proposalId: 'proposal-1',
        status: 'accepted' as const,
        result: 'applied' as const,
        sharedConfig: { ...sharedConfig, userGuidance: '成员建议' },
      };
    });

    await controller.resolveProposal('proposal-1', {
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      resolution: 'accept-selected',
      selectedChangeIds: ['guidance-1'],
    });
    const installed = controller.getSnapshot().session;
    // 不得用过期响应回退本地权威。
    expect(installed?.snapshot.revision).toBe(2);
    expect(installed?.snapshot.sharedConfig).toEqual(roomConfigAfterResponse.sharedConfig);
    // 过期响应也不得移除提案；由后续权威事件清理。
    expect(installed?.snapshot.proposals).toEqual([proposal]);
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 3,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'proposal.resolved',
      payload: { proposalId: 'proposal-1', status: 'accepted' },
    }));
    expect(controller.getSnapshot().session?.snapshot.proposals).toEqual([]);
  });

  it('resolve 响应缺 sharedConfig（旧服务器）时保持等待 WSS 的旧行为', async () => {
    const { client, controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const proposal = {
      proposalVersion: 1 as const,
      proposalId: 'proposal-1',
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted' as const,
      changes: [{
        changeId: 'guidance-1',
        type: 'setUserGuidance' as const,
        value: '成员建议',
        expectedBase: { kind: 'value' as const, value: '' },
      }],
      createdAt: '2026-08-28T00:01:00.000Z',
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal },
    }));
    vi.mocked(client.resolveProposal).mockResolvedValueOnce({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      revision: 1,
      proposalId: 'proposal-1',
      status: 'accepted',
      result: 'applied',
    });

    await controller.resolveProposal('proposal-1', {
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      resolution: 'accept-selected',
      selectedChangeIds: ['guidance-1'],
    });
    expect(controller.getSnapshot()).toMatchObject({
      proposalOperation: null,
      proposalResultUnknown: false,
      notice: '请求已确认，等待房间状态同步',
    });
    expect(controller.getSnapshot().session?.snapshot.proposals).toEqual([proposal]);
    expect(controller.getSnapshot().session?.snapshot.revision).toBe(0);

    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'room.config.updated',
      payload: {
        revision: 1,
        sharedConfig: { ...sharedConfig, userGuidance: '成员建议' },
      },
    }));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 3,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'proposal.resolved',
      payload: { proposalId: 'proposal-1', status: 'accepted' },
    }));
    const synced = controller.getSnapshot().session;
    expect(synced?.snapshot.revision).toBe(1);
    expect(synced?.snapshot.proposals).toEqual([]);
  });

  it('Proposal 结果未知时冻结重复 mutation，等待 WSS/snapshot 对账', async () => {
    const { client, controller, sockets } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'user-member',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
      snapshot: {
        ...snapshot,
        members: [
          snapshot.members[0]!,
          {
            userId: 'user-member',
            role: 'member' as const,
            displayName: '成员',
            membershipState: 'active' as const,
          },
        ],
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    let rejectMutation!: (error: unknown) => void;
    vi.mocked(client.submitProposal).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectMutation = reject;
    }));
    await controller.join('room-1', '成员');
    sockets[0]!.open();
    const intent = {
      proposalId: 'proposal-stable',
      expectedRoomEpoch: 'epoch-1',
      baseRevision: 0,
      changes: [{
        changeId: 'guidance-1',
        type: 'setUserGuidance' as const,
        value: '成员建议',
        expectedBase: { kind: 'value' as const, value: '' },
      }],
    };
    const mutation = controller.submitProposal(intent);
    const proposal = {
      proposalVersion: 1 as const,
      proposalId: intent.proposalId,
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted' as const,
      changes: intent.changes,
      createdAt: '2026-08-28T00:01:00.000Z',
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal },
    }));
    rejectMutation(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '请求可能已提交，请先确认房间状态，不要重复提交',
    ));
    await mutation;
    await controller.submitProposal(intent);

    expect(client.submitProposal).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connected',
      proposalOperation: null,
      proposalResultUnknown: true,
      notice: '请求可能已提交，请先确认房间状态，不要重复提交',
    });
    expect(sockets[0]!.close).not.toHaveBeenCalled();

    vi.mocked(client.getSession).mockResolvedValueOnce({
      ...memberSession,
      snapshot: {
        ...memberSession.snapshot,
        controlSeq: 1,
        proposals: [proposal],
      },
    });
    controller.reconnect();
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledWith('room-1'));
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      proposalResultUnknown: false,
      session: { snapshot: { controlSeq: 1, proposals: [{ proposalId: 'proposal-stable' }] } },
    }));
    expect(client.issueTicket).toHaveBeenCalledTimes(2);
  });

  it('config publish 重做 host/epoch/revision fence，并拒绝 stale intent', async () => {
    const { client, controller } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.publishConfig({
      expectedRoomEpoch: 'epoch-stale',
      expectedRevision: 0,
      expectedControlSeq: 0,
      sharedConfig: { ...sharedConfig, userGuidance: '不能发布' },
    });
    await controller.publishConfig({
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 7,
      expectedControlSeq: 7,
      sharedConfig: { ...sharedConfig, userGuidance: '仍不能发布' },
    });

    expect(client.publishConfig).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      configPublishPending: false,
      configPublishResultUnknown: false,
      notice: null,
      error: '房间配置已发生变化，请重新确认后再发布',
      session: { snapshot: { revision: 0, sharedConfig } },
    });
  });

  it('config publish single-flight 且不乐观递增 revision，只安装权威 response', async () => {
    const { client, controller } = createHarness();
    const desired = { ...sharedConfig, userGuidance: '显式发布' };
    const published = {
      ...session,
      snapshot: {
        ...snapshot,
        revision: 1,
        controlSeq: 1,
        sharedConfig: desired,
      },
    };
    let resolvePublish!: (value: typeof published) => void;
    vi.mocked(client.publishConfig).mockImplementationOnce(() => new Promise((resolve) => {
      resolvePublish = resolve;
    }));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    const request = {
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      expectedControlSeq: 0,
      sharedConfig: desired,
    };

    const first = controller.publishConfig(request);
    const concurrent = controller.publishConfig(request);
    expect(client.publishConfig).toHaveBeenCalledOnce();
    expect(client.publishConfig).toHaveBeenCalledWith('room-1', request);
    expect(controller.getSnapshot()).toMatchObject({
      configPublishPending: true,
      configPublishResultUnknown: false,
      session: { snapshot: { revision: 0, sharedConfig } },
    });

    resolvePublish(published);
    const [confirmed, blocked] = await Promise.all([first, concurrent]);
    expect(confirmed).toEqual({ kind: 'confirmed', session: published });
    expect(blocked).toMatchObject({ kind: 'rejected' });
    expect(controller.getSnapshot()).toMatchObject({
      configPublishPending: false,
      configPublishResultUnknown: false,
      notice: '房间配置已更新',
      error: null,
      session: { snapshot: { revision: 1, controlSeq: 1, sharedConfig: desired } },
    });
  });

  it.each(['http', 'event', 'snapshot', 'reconnect'] as const)('latest publish 的 %s 只由原 HTTP 回执确认，其余路径只观察目标', async (transport) => {
    const { client, controller, sockets } = createHarness();
    const config = (versionToken: string) => ({
      ...sharedConfig,
      combatants: [{ key: 'data-card:card-1', ref: { id: 'card-1', kind: 'character' as const, versionToken } }],
    });
    const published = { ...session, snapshot: { ...snapshot, revision: 1, controlSeq: 1, sharedConfig: config('v2') } };
    if (transport === 'http') vi.mocked(client.publishConfig).mockResolvedValueOnce(published);
    else vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '结果未知'));
    await controller.create({ displayName: '房主', directory: { title: '测试房', visibility: 'public' }, sharedConfig });
    await controller.publishConfig({
      expectedRoomEpoch: 'epoch-1', expectedRevision: 0, expectedControlSeq: 0, sharedConfig: config('v1'),
    });
    if (transport === 'event' || transport === 'snapshot') {
      sockets[0]!.message(JSON.stringify({
        protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', controlSeq: 1,
        timestamp: '2026-08-31T00:02:00.000Z',
        type: transport === 'event' ? 'room.config.updated' : 'room.snapshot',
        payload: transport === 'event' ? { revision: 1, sharedConfig: config('v2') } : published.snapshot,
      }));
    } else if (transport === 'reconnect') {
      vi.mocked(client.getSession).mockResolvedValueOnce(published);
      controller.reconnect();
      await vi.waitFor(() => expect(controller.getSnapshot().session?.snapshot.revision).toBe(1));
    }
    expect(controller.getSnapshot()).toMatchObject({
      configPublishPending: false, configPublishResultUnknown: transport !== 'http', error: null,
      session: { snapshot: { revision: 1, sharedConfig: config('v2') } },
    });
  });

  it('config publish unknown 不伪造 revision，并由匹配的权威事件对账', async () => {
    const { client, controller, sockets } = createHarness();
    const desired = { ...sharedConfig, userGuidance: '结果未知' };
    vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '请求可能已提交，请先确认房间状态，不要重复提交',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.publishConfig({
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      expectedControlSeq: 0,
      sharedConfig: desired,
    });
    await controller.publishConfig({
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      expectedControlSeq: 0,
      sharedConfig: desired,
    });

    expect(client.publishConfig).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      configPublishPending: false,
      configPublishResultUnknown: true,
      notice: '请求可能已提交，请先确认房间状态，不要重复提交',
      error: null,
      session: { snapshot: { revision: 0, sharedConfig } },
    });

    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-31T00:02:00.000Z',
      type: 'room.config.updated',
      payload: { revision: 1, sharedConfig: desired },
    }));
    expect(controller.getSnapshot()).toMatchObject({
      configPublishResultUnknown: true,
      configTracking: { phase: 'unknown', observation: 'target-matches' },
      session: { snapshot: { revision: 1, sharedConfig: desired } },
    });
  });

  it('幂等 config publish 响应丢失且无事件时只读核对保留 unknown', async () => {
    const { client, controller, sockets } = createHarness();
    vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '请求可能已提交，请先确认房间状态，不要重复提交',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    await controller.publishConfig({
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      expectedControlSeq: 0,
      sharedConfig,
    });
    expect(controller.getSnapshot().configPublishResultUnknown).toBe(true);

    vi.mocked(client.getSession).mockResolvedValueOnce(session);
    controller.reconnect();
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledWith('room-1'));
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      configPublishPending: false,
      configPublishResultUnknown: true,
      session: { roomEpoch: 'epoch-1', snapshot: { revision: 0, sharedConfig } },
    }));
    expect(client.issueTicket).toHaveBeenCalledTimes(2);
  });

  it('reset/dispose 使在途 config publish response 失效', async () => {
    for (const cleanup of ['reset', 'dispose'] as const) {
      const { client, controller } = createHarness();
      const desired = { ...sharedConfig, userGuidance: cleanup };
      const published = {
        ...session,
        snapshot: { ...snapshot, revision: 1, controlSeq: 1, sharedConfig: desired },
      };
      let resolvePublish!: (value: typeof published) => void;
      vi.mocked(client.publishConfig).mockImplementationOnce(() => new Promise((resolve) => {
        resolvePublish = resolve;
      }));
      await controller.create({
        displayName: '房主',
        directory: { title: '测试房', visibility: 'public' },
        sharedConfig,
      });
      const publishing = controller.publishConfig({
        expectedRoomEpoch: 'epoch-1',
        expectedRevision: 0,
        expectedControlSeq: 0,
        sharedConfig: desired,
      });

      controller[cleanup]();
      resolvePublish(published);
      await publishing;

      expect(controller.getSnapshot().session?.snapshot.revision ?? 0).toBe(0);
    }
  });

  it('Proposal unknown 只由同一 proposal 的权威事件解锁', async () => {
    const memberSession = {
      ...session,
      self: {
        userId: 'user-member',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
      snapshot: {
        ...snapshot,
        members: [
          snapshot.members[0]!,
          {
            userId: 'user-member',
            role: 'member' as const,
            displayName: '成员',
            membershipState: 'active' as const,
          },
        ],
      },
    };
    const proposal = (proposalId: string) => ({
      proposalVersion: 1 as const,
      proposalId,
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted' as const,
      changes: [{
        changeId: `${proposalId}-guidance`,
        type: 'setUserGuidance' as const,
        value: '成员建议',
        expectedBase: { kind: 'value' as const, value: '' },
      }],
      createdAt: '2026-08-28T00:01:00.000Z',
    });
    const unknown = () => new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '请求可能已提交，请先确认房间状态，不要重复提交',
    );
    const submittedEvent = (proposalId: string, controlSeq: number) => JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal: proposal(proposalId) },
    });
    const resolvedEvent = (
      proposalId: string,
      controlSeq: number,
      status: 'accepted' | 'withdrawn',
    ) => JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'proposal.resolved',
      payload: { proposalId, status },
    });

    const submit = createHarness();
    vi.mocked(submit.client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(submit.client.submitProposal).mockRejectedValueOnce(unknown());
    await submit.controller.join('room-1', '成员');
    submit.sockets[0]!.open();
    await submit.controller.submitProposal({
      proposalId: 'proposal-submit-target',
      expectedRoomEpoch: 'epoch-1',
      baseRevision: 0,
      changes: proposal('proposal-submit-target').changes,
    });
    submit.sockets[0]!.message(submittedEvent('proposal-unrelated', 1));
    expect(submit.controller.getSnapshot().proposalResultUnknown).toBe(true);
    submit.sockets[0]!.message(submittedEvent('proposal-submit-target', 2));
    expect(submit.controller.getSnapshot().proposalResultUnknown).toBe(false);

    const resolve = createHarness();
    vi.mocked(resolve.client.resolveProposal).mockRejectedValueOnce(unknown());
    await resolve.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    resolve.sockets[0]!.open();
    await resolve.controller.resolveProposal('proposal-resolve-target', {
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      resolution: 'reject',
    });
    resolve.sockets[0]!.message(submittedEvent('proposal-unrelated', 1));
    expect(resolve.controller.getSnapshot().proposalResultUnknown).toBe(true);
    resolve.sockets[0]!.message(resolvedEvent('proposal-resolve-target', 2, 'accepted'));
    expect(resolve.controller.getSnapshot().proposalResultUnknown).toBe(false);

    const withdraw = createHarness();
    vi.mocked(withdraw.client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(withdraw.client.withdrawProposal).mockRejectedValueOnce(unknown());
    await withdraw.controller.join('room-1', '成员');
    withdraw.sockets[0]!.open();
    await withdraw.controller.withdrawProposal('proposal-withdraw-target');
    withdraw.sockets[0]!.message(resolvedEvent('proposal-unrelated', 1, 'withdrawn'));
    expect(withdraw.controller.getSnapshot().proposalResultUnknown).toBe(true);
    withdraw.sockets[0]!.message(resolvedEvent('proposal-withdraw-target', 2, 'withdrawn'));
    expect(withdraw.controller.getSnapshot().proposalResultUnknown).toBe(false);
  });

  it('忽略重复 control event，跳号时请求 reconnect/resync', async () => {
    const { client, controller, queued, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const member = {
      userId: 'user-member',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
      joinedAt: '2026-08-28T00:01:00.000Z',
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'room.member.joined',
      payload: { member },
    }));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'room.member.joined',
      payload: { member: { ...member, displayName: '过期名称' } },
    }));
    expect(controller.getSnapshot().session?.snapshot.members[1]?.displayName).toBe('成员');

    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 3,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'room.member.joined',
      payload: { member: { ...member, displayName: '跳号名称' } },
    }));
    expect(controller.getSnapshot().phase).toBe('reconnecting');
    expect(controller.getSnapshot().session?.snapshot.controlSeq).toBe(1);
    expect(client.issueTicket).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(1);
  });

  it('epoch replacement 使用 full snapshot 并明确提示重新同步', async () => {
    const { controller, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const recovered = {
      ...snapshot,
      roomEpoch: 'epoch-2',
      controlSeq: 1,
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-2',
      controlSeq: 1,
      timestamp: '2026-08-28T00:05:00.000Z',
      type: 'room.snapshot',
      payload: recovered,
    }));

    expect(controller.getSnapshot()).toMatchObject({
      notice: '房间已由服务器恢复，需要重新同步',
      session: { roomEpoch: 'epoch-2' },
    });
  });

  it('1008/reconnect 耗尽进入 replacement，且 dispose 清 timer/socket', async () => {
    const first = createHarness();
    await first.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    first.sockets[0]!.open();
    first.sockets[0]!.closed(1008, 'membership-revoked');
    expect(first.controller.getSnapshot()).toMatchObject({
      phase: 'replacement',
      session: null,
      notice: '原房间无法恢复，请房主创建新房间',
    });

    const second = createHarness();
    vi.mocked(second.client.issueTicket).mockRejectedValue(
      new Error('runtime unavailable') as ArenaRoomClientError,
    );
    await second.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    expect(second.controller.getSnapshot().phase).toBe('degraded');
    await second.runNextTimer();
    await second.runNextTimer();
    expect(second.controller.getSnapshot()).toMatchObject({
      phase: 'replacement',
      session: null,
      notice: '原房间无法恢复，请房主创建新房间',
    });
    second.controller.dispose();
    expect(second.queued).toHaveLength(0);
  });

  it('member 收到 membership-revoked 时提示成员资格结束而不是要求创建房间', async () => {
    const harness = createHarness();
    const member = {
      userId: 'user-member',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    vi.mocked(harness.client.join).mockResolvedValueOnce({
      ...session,
      self: member,
      snapshot: { ...snapshot, members: [...snapshot.members, member] },
    });
    await harness.controller.join('room-1', '成员');
    harness.sockets[0]!.open();
    harness.sockets[0]!.closed(1008, 'membership-revoked');

    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'replacement',
      session: null,
      notice: '当前成员资格已结束，原房间无法恢复',
    });
  });

  it('room-authority-fenced（1008/1013）按可重试处理，预算耗尽才进入 replacement', async () => {
    const harness = createHarness();
    await harness.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    harness.sockets[0]!.open();
    // 回归：fenced 只表示当前进程 incarnation 失去 authority，房间可经服务端
    // 重启后恢复，必须消耗重连预算而不是立即终态。
    harness.sockets[0]!.closed(1008, 'room-authority-fenced');
    expect(harness.controller.getSnapshot()).toMatchObject({ phase: 'degraded', session: { roomId: 'room-1' } });
    await harness.runNextTimer();
    expect(harness.client.issueTicket).toHaveBeenCalledTimes(2);

    harness.sockets[1]!.open();
    harness.sockets[1]!.closed(1013, 'room-authority-fenced');
    await harness.runNextTimer();
    expect(harness.client.issueTicket).toHaveBeenCalledTimes(3);

    harness.sockets[2]!.open();
    harness.sockets[2]!.closed(1013, 'room-authority-fenced');
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'replacement',
      notice: '原房间无法恢复，请房主创建新房间',
    });
  });

  it('post-open 1013 不清零跨连接预算，重连最终有界熔断', async () => {
    const { client, controller, runNextTimer, sockets } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.closed(1013, 'authority-unavailable');
    await runNextTimer();
    sockets[1]!.open();
    sockets[1]!.closed(1013, 'authority-unavailable');
    await runNextTimer();
    sockets[2]!.open();
    sockets[2]!.closed(1013, 'authority-unavailable');

    expect(client.issueTicket).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'replacement',
      notice: '原房间无法恢复，请房主创建新房间',
    });
  });

  it('只有 host 显式 start；unknown 不自动 POST，显式 retry 复用内存中的同一完整请求', async () => {
    const host = createHarness();
    await host.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    host.sockets[0]!.open();
    await host.controller.startGeneration(generationStartRequest);

    expect(host.client.startGeneration).toHaveBeenCalledOnce();
    expect(host.client.startGeneration).toHaveBeenCalledWith('room-1', generationStartRequest);
    expect(host.controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      mirror: generationMirror,
      status: 'running',
      markdown: '权威基线',
      finalAuthoritative: false,
      startResultUnknown: false,
    });
    expect(JSON.stringify(host.controller.getSnapshot())).not.toContain('test-secret-canary');

    const unknown = createHarness();
    vi.mocked(unknown.client.startGeneration).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '请求可能已提交，请先确认房间状态，不要重复提交',
    ));
    await unknown.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    unknown.sockets[0]!.open();
    await unknown.controller.startGeneration(generationStartRequest);
    unknown.sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'room.snapshot',
      payload: { ...snapshot, controlSeq: 1 },
    }));
    await unknown.controller.startGeneration(generationStartRequest);

    expect(unknown.client.startGeneration).toHaveBeenCalledOnce();
    expect(unknown.controller.getSnapshot().generation).toMatchObject({
      phase: 'unknown',
      pendingRequestId: 'request-12345678',
      startResultUnknown: true,
    });
    vi.mocked(unknown.client.startGeneration).mockResolvedValueOnce(generationView);
    await unknown.controller.retryGenerationStart();
    expect(unknown.client.startGeneration).toHaveBeenCalledTimes(2);
    expect(unknown.client.startGeneration).toHaveBeenLastCalledWith(
      'room-1',
      generationStartRequest,
    );
    expect(unknown.controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      startResultUnknown: false,
    });

    const member = createHarness();
    vi.mocked(member.client.join).mockResolvedValueOnce({
      ...session,
      self: {
        userId: 'user-member',
        role: 'member',
        displayName: '成员',
        membershipState: 'active',
      },
      snapshot: {
        ...snapshot,
        members: [
          snapshot.members[0]!,
          {
            userId: 'user-member',
            role: 'member',
            displayName: '成员',
            membershipState: 'active',
          },
        ],
      },
    });
    await member.controller.join('room-1', '成员');
    await member.controller.startGeneration(generationStartRequest);
    await member.controller.retryGenerationStart();
    expect(member.client.startGeneration).not.toHaveBeenCalled();
  });

  it('start response 不再把 request config/revision 伪装成已显式发布的权威状态', async () => {
    const host = createHarness();
    const pendingConfig = { ...sharedConfig, userGuidance: '最终房主配置' };
    vi.mocked(host.client.startGeneration).mockResolvedValueOnce({
      ...generationView,
      generation: { ...generationMirror, configRevision: 1 },
    });
    await host.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    await host.controller.startGeneration({
      ...generationStartRequest,
      sharedConfig: pendingConfig,
    });
    expect(host.controller.getSnapshot().session?.snapshot).toMatchObject({
      revision: 0,
      sharedConfig,
      activeGeneration: { generationId: 'generation-1', configRevision: 1 },
    });
  });

  it('unknown 后 Room epoch 恢复时显式 retry 只重绑 epoch 并复用同一 intent/payload', async () => {
    const recovered = createHarness();
    vi.mocked(recovered.client.startGeneration).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '请求可能已提交，请先确认房间状态，不要重复提交',
    ));
    await recovered.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    recovered.sockets[0]!.open();
    await recovered.controller.startGeneration(generationStartRequest);
    vi.mocked(recovered.client.getGenerationView).mockRejectedValueOnce(
      new Error('generation projection unavailable'),
    );
    recovered.sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-2',
      controlSeq: 2,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'room.snapshot',
      payload: {
        ...snapshot,
        roomEpoch: 'epoch-2',
        controlSeq: 2,
        activeGeneration: { ...generationMirror, state: 'starting' },
      },
    }));
    await vi.waitFor(() => {
      expect(recovered.controller.getSnapshot().generation.phase).toBe('unavailable');
    });
    vi.mocked(recovered.client.startGeneration).mockResolvedValueOnce({
      ...generationView,
      roomEpoch: 'epoch-2',
      generation: { ...generationMirror, state: 'running' },
    });

    await recovered.controller.retryGenerationStart();

    expect(recovered.client.startGeneration).toHaveBeenCalledTimes(2);
    expect(recovered.client.startGeneration).toHaveBeenLastCalledWith('room-1', {
      ...generationStartRequest,
      expectedRoomEpoch: 'epoch-2',
    });
    expect(recovered.controller.getSnapshot().generation.phase).toBe('running');
  });

  it('story 仅接受 0-based contiguous chunk，忽略重复并在 gap 冻结后 single-flight GET', async () => {
    const { client, controller, sockets } = createHarness();
    let resolveRecovery!: (value: typeof generationView) => void;
    vi.mocked(client.getGenerationView).mockImplementation(() => new Promise((resolve) => {
      resolveRecovery = resolve;
    }));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));
    expect(client.getGenerationView).toHaveBeenCalledOnce();
    resolveRecovery({ ...generationView, markdown: '' });
    await vi.waitFor(() => expect(controller.getSnapshot().generation.phase).toBe('running'));
    const story = (chunkSeq: number, delta: string) => JSON.stringify({
      protocolVersion: 1,
      type: 'story.delta',
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      generationId: 'generation-1',
      chunkSeq,
      timestamp: '2026-08-28T00:02:00.000Z',
      payload: { delta },
    });
    sockets[0]!.message(story(0, 'A'));
    sockets[0]!.message(story(0, '重复'));
    sockets[0]!.message(story(1, 'B'));
    expect(controller.getSnapshot().generation).toMatchObject({
      markdown: 'AB',
      storyCursor: { generationId: 'generation-1', chunkSeq: 1 },
      gap: null,
    });

    sockets[0]!.message(story(3, '跳号'));
    sockets[0]!.message(story(4, '继续跳号'));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      type: 'room.resync.required',
      reason: 'replay-unavailable',
    }));
    expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'resyncing',
      markdown: 'AB',
      gap: {
        generationId: 'generation-1',
        expectedChunkSeq: 2,
        receivedChunkSeq: 3,
      },
    });
    expect(client.getGenerationView).toHaveBeenCalledTimes(2);

    resolveRecovery({
      ...generationView,
      markdown: '权威全文',
      nextChunkSeq: 4,
    });
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      markdown: '权威全文',
      authoritativeMarkdown: '权威全文',
      storyCursor: { generationId: 'generation-1', chunkSeq: 3 },
      gap: null,
    }));
  });

  it('generation.started 立即读取权威基线，避免晚加入客户端从错误 chunk 起点拼接', async () => {
    const { client, controller, sockets } = createHarness();
    let resolveBaseline!: (value: typeof generationView) => void;
    vi.mocked(client.getGenerationView).mockImplementation(() => new Promise((resolve) => {
      resolveBaseline = resolve;
    }));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));

    expect(client.getGenerationView).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().generation.phase).toBe('resyncing');

    resolveBaseline({ ...generationView, markdown: '已生成基线', nextChunkSeq: 2 });
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      markdown: '已生成基线',
      storyCursor: { generationId: 'generation-1', chunkSeq: 1 },
    }));
  });

  it('generation GET 临时失败时只对 safe-read 有界重试，并在恢复后安装权威视图', async () => {
    const { client, controller, queued, sockets, runNextTimer } = createHarness({
      recoveryDelayMs: () => 0,
    });
    vi.mocked(client.getGenerationView)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_UNAVAILABLE',
        503,
        '房间运行时暂不可用',
      ))
      .mockResolvedValueOnce(generationView);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));

    await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledOnce());
    expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'resyncing',
      errorCode: null,
      recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT',
    });
    await vi.waitFor(() => expect(controller.getSnapshot().notice).toContain('正在自动重试'));

    await vi.waitFor(() => expect(queued).toHaveLength(1));
    await runNextTimer();
    await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      errorCode: null,
      markdown: '权威基线',
    }));
    expect(client.startGeneration).not.toHaveBeenCalled();
  });

  it('generation 404 且 session 已无 active generation 时停止旧等待，不再渲染运行中状态', async () => {
    const { client, controller, sockets } = createHarness();
    vi.mocked(client.getGenerationView).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_GENERATION_NOT_FOUND',
      404,
      '未找到生成记录',
    ));
    vi.mocked(client.getSession).mockResolvedValueOnce(session);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));

    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledWith(
      'room-1',
      expect.any(AbortSignal),
    ));
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'unavailable',
      mirror: null,
      errorCode: null,
      recoveryCode: 'ROOM_GENERATION_RECOVERY_NOT_FOUND',
    }));
    expect(controller.getSnapshot().notice).toContain('不再生成');
    expect(client.getGenerationView).toHaveBeenCalledOnce();
  });

  it('generation 404 但 session 仍指向同一 generation 时在预算内重试 safe-read', async () => {
    const { client, controller, queued, sockets, runNextTimer } = createHarness({
      recoveryDelayMs: () => 0,
    });
    const sessionWithGeneration = {
      ...session,
      snapshot: { ...snapshot, activeGeneration: generationMirror },
    };
    vi.mocked(client.getGenerationView)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_GENERATION_NOT_FOUND',
        404,
        '未找到生成记录',
      ))
      .mockResolvedValueOnce(generationView);
    vi.mocked(client.getSession).mockResolvedValueOnce(sessionWithGeneration);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));

    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledWith(
      'room-1',
      expect.any(AbortSignal),
    ));
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    await runNextTimer();
    await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      markdown: '权威基线',
    }));
    expect(client.startGeneration).not.toHaveBeenCalled();
  });

  it('generation 404 后 session 已切换到新 generation 时停止旧读取并恢复新战报', async () => {
    const { client, controller, sockets } = createHarness();
    const nextGeneration = {
      ...generationMirror,
      generationRequestId: 'request-23456789',
      generationId: 'generation-2',
    };
    const sessionWithNextGeneration = {
      ...session,
      snapshot: {
        ...snapshot,
        controlSeq: 2,
        activeGeneration: nextGeneration,
      },
    };
    vi.mocked(client.getGenerationView)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_GENERATION_NOT_FOUND',
        404,
        '未找到生成记录',
      ))
      .mockResolvedValueOnce({
        ...generationView,
        generation: nextGeneration,
        markdown: '新战报基线',
      });
    vi.mocked(client.getSession).mockResolvedValueOnce(sessionWithNextGeneration);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sendGenerationControlEvent(sockets[0]!, 'generation.started', 1);

    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledWith(
      'room-1',
      expect.any(AbortSignal),
    ));
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      mirror: { generationId: 'generation-2' },
      markdown: '新战报基线',
      recoveryCode: null,
    }));
    expect(client.getGenerationView).toHaveBeenCalledTimes(2);
    expect(client.startGeneration).not.toHaveBeenCalled();
  });

  it('generation recovery 临时失败最多执行四次 GET，耗尽后停止自动重试', async () => {
    const { client, controller, queued, sockets, runNextTimer } = createHarness({
      recoveryDelayMs: () => 0,
    });
    vi.mocked(client.getGenerationView).mockRejectedValue(new ArenaRoomClientError(
      'ROOM_UNAVAILABLE',
      503,
      '房间运行时暂不可用',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));

    for (let expectedCalls = 1; expectedCalls <= 4; expectedCalls += 1) {
      await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledTimes(expectedCalls));
      if (expectedCalls < 4) {
        await vi.waitFor(() => expect(queued).toHaveLength(1));
        await runNextTimer();
      }
    }
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'unavailable',
      errorCode: null,
      recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT',
    }));
    expect(client.getGenerationView).toHaveBeenCalledTimes(4);
    expect(client.startGeneration).not.toHaveBeenCalled();
  });

  it('generation recovery 对单次 safe-read 设置独立超时，永不结束的 GET 会被取消', async () => {
    const {
      client,
      controller,
      queued,
      recoveryTimeouts,
      runNextRecoveryTimeout,
      sockets,
    } = createHarness({
      generationRecoveryAttemptTimeoutMs: 100,
      recoveryDelayMs: () => 0,
    });
    const signals: AbortSignal[] = [];
    vi.mocked(client.getGenerationView).mockImplementation((_roomId, _generationId, signal) => (
      new Promise<typeof generationView>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('recovery signal missing'));
          return;
        }
        signals.push(signal);
      })
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sendGenerationControlEvent(sockets[0]!, 'generation.started', 1);

    await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recoveryTimeouts).toHaveLength(1));
    await runNextRecoveryTimeout();
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'resyncing',
      recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT',
    }));
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(true);
    expect(client.getGenerationView).toHaveBeenCalledOnce();
    controller.reset();
  });

  it('generation.failed 的业务 errorCode 不会被 safe-read 临时失败覆盖', async () => {
    const { client, controller, queued, sockets } = createHarness({
      recoveryDelayMs: () => 0,
    });
    vi.mocked(client.getGenerationView).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_UNAVAILABLE',
      503,
      '房间运行时暂不可用',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sendGenerationControlEvent(sockets[0]!, 'generation.failed', 1, {
      errorCode: 'generation-failed',
    });

    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'resyncing',
      status: 'failed',
      errorCode: 'generation-failed',
      recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT',
    }));
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    controller.reset();
  });

  it('已完成 generation 的 recovery 耗尽后保留完成事实，手动重试仍只做 GET', async () => {
    const { client, controller, queued, runNextTimer, sockets } = createHarness({
      recoveryDelayMs: () => 0,
    });
    vi.mocked(client.getGenerationView).mockRejectedValue(new ArenaRoomClientError(
      'ROOM_UNAVAILABLE',
      503,
      '房间运行时暂不可用',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sendGenerationControlEvent(sockets[0]!, 'generation.completed', 1, {
      generationRecordId: 'record-1',
    });

    for (let expectedCalls = 1; expectedCalls <= 4; expectedCalls += 1) {
      await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledTimes(expectedCalls));
      if (expectedCalls < 4) {
        await vi.waitFor(() => expect(queued).toHaveLength(1));
        await runNextTimer();
      }
    }
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'completed',
      status: 'completed',
      errorCode: null,
      recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT',
    }));

    vi.mocked(client.getGenerationView).mockResolvedValueOnce({
      ...generationView,
      generation: {
        ...generationMirror,
        state: 'completed',
        finishedAt: '2026-08-28T00:01:00.000Z',
      },
      status: 'completed',
      finalAuthoritative: true,
      generationRecordId: 'record-1',
    });
    await controller.retryGenerationRecovery();

    expect(client.getGenerationView).toHaveBeenCalledTimes(5);
    expect(client.startGeneration).not.toHaveBeenCalled();
    expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'completed',
      status: 'completed',
      finalAuthoritative: true,
      recoveryCode: null,
    });
  });

  it('新的 generation start intent 建立时立即 fence，旧 recovery 不得覆盖 starting 状态', async () => {
    const { client, controller, queued, sockets } = createHarness({
      recoveryDelayMs: () => 0,
    });
    const nextGeneration = {
      ...generationMirror,
      generationRequestId: 'request-23456789',
      generationId: 'generation-2',
    };
    let resolveStart!: (value: typeof generationView) => void;
    vi.mocked(client.getGenerationView).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_UNAVAILABLE',
      503,
      '房间运行时暂不可用',
    ));
    vi.mocked(client.startGeneration).mockImplementationOnce(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sendGenerationControlEvent(sockets[0]!, 'generation.completed', 1, {
      generationRecordId: 'record-1',
    });
    await vi.waitFor(() => expect(queued).toHaveLength(1));

    const starting = controller.startGeneration({
      ...generationStartRequest,
      expectedControlSeq: 1,
    });
    await vi.waitFor(() => expect(controller.getSnapshot().generation.phase).toBe('starting'));
    expect(queued).toHaveLength(0);

    resolveStart({
      ...generationView,
      generation: nextGeneration,
    });
    await starting;
    expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      mirror: { generationId: 'generation-2' },
    });
    expect(client.getGenerationView).toHaveBeenCalledOnce();
    expect(client.startGeneration).toHaveBeenCalledOnce();
  });

  it('protocol recovery 失败后允许手动 safe-read，不会重放 startGeneration', async () => {
    const { client, controller, sockets } = createHarness();
    vi.mocked(client.getGenerationView).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESPONSE_INVALID',
      null,
      '房间服务返回了无效响应',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sendGenerationControlEvent(sockets[0]!, 'generation.started', 1);

    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'unavailable',
      status: 'running',
      recoveryCode: 'ROOM_GENERATION_RECOVERY_PROTOCOL',
    }));
    vi.mocked(client.getGenerationView).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESPONSE_INVALID',
      null,
      '房间服务返回了无效响应',
    ));
    await controller.retryGenerationRecovery();

    expect(client.getGenerationView).toHaveBeenCalledTimes(2);
    expect(client.startGeneration).not.toHaveBeenCalled();
    expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'unavailable',
      recoveryCode: 'ROOM_GENERATION_RECOVERY_PROTOCOL',
    });

    vi.mocked(client.getGenerationView).mockResolvedValueOnce(generationView);
    await controller.retryGenerationRecovery();

    expect(client.getGenerationView).toHaveBeenCalledTimes(3);
    expect(client.startGeneration).not.toHaveBeenCalled();
    expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      recoveryCode: null,
    });
  });

  it('Retry-After 超出自动恢复窗口时停止自动重试，不截断服务器指定的等待', async () => {
    const recoveryDelayMs = vi.fn(() => 0);
    const { client, controller, queued, sockets } = createHarness({ recoveryDelayMs });
    vi.mocked(client.getGenerationView).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_UNAVAILABLE',
      503,
      '房间运行时暂不可用',
      9,
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sendGenerationControlEvent(sockets[0]!, 'generation.started', 1);

    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'unavailable',
      recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT',
    }));
    expect(recoveryDelayMs).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
    expect(client.getGenerationView).toHaveBeenCalledOnce();
  });

  it('generation recovery 的 retry 在 Room fence 变化后停止，不会继续读取旧 generation', async () => {
    const { client, controller, sockets, runNextTimer } = createHarness({
      recoveryDelayMs: () => 0,
    });
    vi.mocked(client.getGenerationView).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_UNAVAILABLE',
      503,
      '房间运行时暂不可用',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));
    await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledOnce());

    controller.reset();
    await runNextTimer();

    expect(client.getGenerationView).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().session).toBeNull();
  });

  it('terminal control 先更新 mirror，再由权威 GET 恢复最终 markdown', async () => {
    const { client, controller, sockets } = createHarness();
    let resolveRecovery!: (value: typeof generationView) => void;
    vi.mocked(client.getGenerationView).mockImplementation(() => new Promise((resolve) => {
      resolveRecovery = resolve;
    }));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
      },
    }));
    expect(client.getGenerationView).toHaveBeenCalledOnce();
    resolveRecovery(generationView);
    await vi.waitFor(() => expect(controller.getSnapshot().generation.phase).toBe('running'));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'generation.completed',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
        generationRecordId: 'record-1',
      },
    }));

    expect(controller.getSnapshot().session?.snapshot.activeGeneration).toMatchObject({
      generationId: 'generation-1',
      state: 'completed',
    });
    expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'resyncing',
      finalAuthoritative: false,
    });
    expect(client.getGenerationView).toHaveBeenCalledTimes(2);

    resolveRecovery({
      ...generationView,
      generation: {
        ...generationMirror,
        state: 'completed',
        finishedAt: '2026-08-28T00:03:00.000Z',
      },
      status: 'completed',
      markdown: '# 最终权威报告',
      nextChunkSeq: 2,
      finalAuthoritative: true,
      generationRecordId: 'record-1',
      result: generationResult,
    });
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'completed',
      status: 'completed',
      markdown: '# 最终权威报告',
      finalAuthoritative: true,
      generationRecordId: 'record-1',
      result: generationResult,
    }));
  });

  it('terminal 使同 attempt 的旧 GET 失效，并在 single-flight 后补一次权威终态 GET', async () => {
    const { client, controller, sockets } = createHarness();
    const recoveryResolvers: Array<(value: typeof generationView) => void> = [];
    vi.mocked(client.getGenerationView).mockImplementation(() => new Promise((resolve) => {
      recoveryResolvers.push(resolve);
    }));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const payload = {
      generationRequestId: generationMirror.generationRequestId,
      generationId: generationMirror.generationId,
      attempt: generationMirror.attempt,
      configRevision: generationMirror.configRevision,
      snapshotDigest: generationMirror.snapshotDigest,
      collaborativeInfluence: generationMirror.collaborativeInfluence,
      participantUserIds: generationMirror.participantUserIds,
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload,
    }));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      type: 'story.delta',
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      generationId: 'generation-1',
      chunkSeq: 2,
      timestamp: '2026-08-28T00:02:00.000Z',
      payload: { delta: '跳号' },
    }));
    expect(client.getGenerationView).toHaveBeenCalledOnce();

    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'generation.completed',
      payload: { ...payload, generationRecordId: 'record-1' },
    }));
    expect(client.getGenerationView).toHaveBeenCalledOnce();

    recoveryResolvers[0]!({
      ...generationView,
      markdown: '过期运行中基线',
      nextChunkSeq: 3,
    });
    await vi.waitFor(() => expect(client.getGenerationView).toHaveBeenCalledTimes(2));
    expect(controller.getSnapshot().generation.markdown).not.toBe('过期运行中基线');

    recoveryResolvers[1]!({
      ...generationView,
      generation: {
        ...generationMirror,
        state: 'completed',
        finishedAt: '2026-08-28T00:03:00.000Z',
      },
      status: 'completed',
      markdown: '# 最终权威报告',
      nextChunkSeq: 3,
      finalAuthoritative: true,
      generationRecordId: 'record-1',
    });
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'completed',
      markdown: '# 最终权威报告',
      finalAuthoritative: true,
    }));
  });

  it('generation GET 响应受 roomEpoch/generationId/dispose fence 约束', async () => {
    const { client, controller, sockets } = createHarness();
    const recoveryResolvers = new Map<string, (value: typeof generationView) => void>();
    vi.mocked(client.getGenerationView).mockImplementation((_roomId, generationId) => (
      new Promise((resolve) => recoveryResolvers.set(generationId, resolve))
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    const payload = {
      generationRequestId: generationMirror.generationRequestId,
      generationId: generationMirror.generationId,
      attempt: generationMirror.attempt,
      configRevision: generationMirror.configRevision,
      snapshotDigest: generationMirror.snapshotDigest,
      collaborativeInfluence: generationMirror.collaborativeInfluence,
      participantUserIds: generationMirror.participantUserIds,
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'generation.started',
      payload,
    }));
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      type: 'story.delta',
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      generationId: 'generation-1',
      chunkSeq: 2,
      timestamp: '2026-08-28T00:02:00.000Z',
      payload: { delta: '跳号' },
    }));

    const generation2 = {
      ...generationMirror,
      generationRequestId: 'request-87654321',
      generationId: 'generation-2',
      startedAt: '2026-08-28T00:04:00.000Z',
    };
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-2',
      controlSeq: 1,
      timestamp: '2026-08-28T00:04:00.000Z',
      type: 'room.snapshot',
      payload: {
        ...snapshot,
        roomEpoch: 'epoch-2',
        controlSeq: 1,
        activeGeneration: generation2,
      },
    }));
    expect(client.getGenerationView).toHaveBeenCalledTimes(2);

    recoveryResolvers.get('generation-1')!({
      ...generationView,
      markdown: '旧 epoch 不得覆盖',
    });
    await Promise.resolve();
    expect(controller.getSnapshot().generation).toMatchObject({
      mirror: { generationId: 'generation-2' },
      markdown: '',
    });

    controller.dispose();
    recoveryResolvers.get('generation-2')!({
      ...generationView,
      roomEpoch: 'epoch-2',
      generation: generation2,
      markdown: 'dispose 后不得写入',
    });
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'closed',
      session: null,
      generation: { mirror: null, markdown: '' },
    });
  });

  it('成员管理使用单飞锁并安装 kick 后的服务器权威 session', async () => {
    const { client, controller } = createHarness();
    const member = {
      userId: 'member-1',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    const withMember = {
      ...session,
      snapshot: { ...snapshot, members: [snapshot.members[0]!, member] },
    };
    vi.mocked(client.create).mockResolvedValueOnce(withMember);
    vi.mocked(client.kick).mockResolvedValueOnce({
      ...withMember,
      snapshot: {
        ...withMember.snapshot,
        members: [snapshot.members[0]!, { ...member, membershipState: 'revoked' as const }],
      },
    });
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await Promise.all([controller.kickMember('member-1'), controller.kickMember('member-1')]);

    expect(client.kick).toHaveBeenCalledOnce();
    expect(client.kick).toHaveBeenCalledWith('room-1', 'member-1', 'epoch-1');
    expect(controller.getSnapshot().managementOperation).toBeNull();
    expect(controller.getSnapshot().managementResultUnknown).toBe(false);
    expect(controller.getSnapshot().session?.snapshot.members.find(
      (candidate) => candidate.userId === 'member-1',
    )?.membershipState).toBe('revoked');
  });

  it('cancel accepted 但仍 running 时不声称已取消，并等待权威终态解除管理锁', async () => {
    const { client, controller, sockets } = createHarness();
    const generatingSession = {
      ...session,
      snapshot: { ...snapshot, activeGeneration: generationMirror },
    };
    vi.mocked(client.create).mockResolvedValueOnce(generatingSession);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await Promise.all([controller.cancelGeneration(), controller.cancelGeneration()]);

    expect(client.cancelGeneration).toHaveBeenCalledOnce();
    expect(client.cancelGeneration).toHaveBeenCalledWith('room-1', 'generation-1', 'epoch-1');
    expect(controller.getSnapshot().managementOperation).toBe('cancel-generation');
    expect(controller.getSnapshot().notice).toContain('正在等待服务器确认');
    expect(controller.getSnapshot().notice).not.toContain('已取消');

    vi.mocked(client.getGenerationView).mockResolvedValueOnce({
      ...generationView,
      generation: {
        ...generationMirror,
        state: 'cancelled',
        finishedAt: '2026-08-28T00:03:00.000Z',
      },
      status: 'cancelled',
      finalAuthoritative: true,
    });
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:03:00.000Z',
      type: 'generation.completed',
      payload: {
        generationRequestId: generationMirror.generationRequestId,
        generationId: generationMirror.generationId,
        attempt: generationMirror.attempt,
        configRevision: generationMirror.configRevision,
        snapshotDigest: generationMirror.snapshotDigest,
        collaborativeInfluence: generationMirror.collaborativeInfluence,
        participantUserIds: generationMirror.participantUserIds,
        generationRecordId: 'record-cancelled',
      },
    }));

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      managementOperation: null,
      managementResultUnknown: false,
      generation: { status: 'cancelled', finalAuthoritative: true },
    }));
    expect(controller.getSnapshot().notice).toContain('服务器确认取消');
  });

  it('kick 结果未知只通过 GET 对账，不盲目重放 mutation', async () => {
    const { client, controller } = createHarness();
    const member = {
      userId: 'member-1',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    const withMember = {
      ...session,
      snapshot: { ...snapshot, members: [snapshot.members[0]!, member] },
    };
    vi.mocked(client.create).mockResolvedValueOnce(withMember);
    vi.mocked(client.kick).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      null,
      '请求结果未知',
    ));
    vi.mocked(client.getSession).mockResolvedValueOnce(session);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.kickMember('member-1');
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();
    await vi.waitFor(() => expect(controller.getSnapshot().managementResultUnknown).toBe(false));
    expect(client.kick).toHaveBeenCalledOnce();
    expect(client.getSession).toHaveBeenCalled();
  });

  it('kick 结果未知后发现房间已结束时清理本地会话', async () => {
    const { client, controller } = createHarness();
    const member = {
      userId: 'member-1',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    vi.mocked(client.create).mockResolvedValueOnce({
      ...session,
      snapshot: { ...snapshot, members: [snapshot.members[0]!, member] },
    });
    vi.mocked(client.kick).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      null,
      '请求结果未知',
    ));
    vi.mocked(client.getSession).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_NOT_FOUND',
      404,
      '房间不存在或已关闭',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.kickMember('member-1');
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '房间会话已结束',
    }));
    expect(client.kick).toHaveBeenCalledOnce();
  });

  it('leave 成功后立即结束本地房间会话并保留一次性提示', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
      snapshot: {
        ...snapshot,
        members: [
          snapshot.members[0]!,
          {
            userId: 'member-1',
            role: 'member' as const,
            displayName: '成员',
            membershipState: 'active' as const,
          },
        ],
        activeGeneration: generationMirror,
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    await controller.join('room-1', '成员');

    await controller.leave();

    expect(client.leave).toHaveBeenCalledWith('room-1', 'epoch-1');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      notice: '已离开房间',
      managementOperation: null,
      managementResultUnknown: false,
      generation: { phase: 'idle', mirror: null, markdown: '' },
    });
  });

  it('leave 结果未知时优先幂等重放同一离开意图并收敛终态', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    // 第一次 leave 已在服务端生效但成功响应丢失（ROOM_RESULT_UNKNOWN）：
    // 服务端对同 epoch 的已撤销成员幂等返回 left，重放直接收敛，
    // 不依赖 GET session（revoked 后 session 读取只会 403）。
    vi.mocked(client.leave)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockResolvedValueOnce({ protocolVersion: 1, roomId: 'room-1', outcome: 'left' });
    await controller.join('room-1', '成员');

    await controller.leave();
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '已离开房间',
    }));
    expect(client.leave).toHaveBeenCalledTimes(2);
    expect(client.leave).toHaveBeenNthCalledWith(2, 'room-1', 'epoch-1');
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('leave 结果未知且重放返回 not found 时收敛为会话已结束', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(client.leave)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_NOT_FOUND',
        404,
        '房间会话不存在或已结束',
      ));
    await controller.join('room-1', '成员');

    await controller.leave();
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '已确认当前房间会话已结束',
    }));
    expect(client.leave).toHaveBeenCalledTimes(2);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('leave 直接返回通用 forbidden 时保留会话并显示失败原因', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(client.leave).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_FORBIDDEN',
      403,
      '没有此房间操作权限',
    ));
    await controller.join('room-1', '成员');

    await controller.leave();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      session: memberSession,
      notice: '离开房间失败，正在重新连接…',
      error: '没有此房间操作权限',
      managementOperation: null,
      managementResultUnknown: false,
    });
  });

  it('leave 结果未知且会话仍可读取时也直接重放收敛，无需读取会话', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(client.leave)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockResolvedValueOnce({ protocolVersion: 1, roomId: 'room-1', outcome: 'left' });
    vi.mocked(client.getSession).mockResolvedValue(memberSession);
    await controller.join('room-1', '成员');

    await controller.leave();
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '已离开房间',
    }));
    expect(client.leave).toHaveBeenCalledTimes(2);
    expect(client.leave).toHaveBeenLastCalledWith('room-1', 'epoch-1');
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('leave 结果未知且重放仍未知时保持 unknown 并按再次提交提示', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(client.leave).mockRejectedValue(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      null,
      '请求结果未知',
    ));
    await controller.join('room-1', '成员');

    await controller.leave();
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      session: memberSession,
      managementOperation: 'leave',
      managementResultUnknown: true,
    }));
    expect(client.leave).toHaveBeenCalledTimes(2);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('leave 重放返回 forbidden（成员资格已不存在）时按已退出收敛', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    // 服务端 leave 在 epoch 匹配但该账号已无成员记录时返回 403：
    // 对 leave intent 而言即“已不在房间”，按已退出收敛。
    vi.mocked(client.leave)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_FORBIDDEN',
        403,
        '没有此房间操作权限',
      ));
    await controller.join('room-1', '成员');

    await controller.leave();
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '已离开房间',
    }));
    expect(client.leave).toHaveBeenCalledTimes(2);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('close 结果未知且房间仍开放时安全重放同一关闭意图并收敛终态', async () => {
    const { client, controller } = createHarness();
    vi.mocked(client.close)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockResolvedValueOnce({ protocolVersion: 1, roomId: 'room-1', outcome: 'closed' });
    vi.mocked(client.getSession).mockResolvedValueOnce(session);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.close();
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '房间已关闭',
    }));
    expect(client.close).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenLastCalledWith('room-1', 'epoch-1');
    expect(client.getSession).toHaveBeenCalledOnce();
  });

  it('kick 结果未知且目标仍在房间时安全重放同一移除意图并安装权威会话', async () => {
    const { client, controller } = createHarness();
    const member = {
      userId: 'member-1',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    const withMember = {
      ...session,
      snapshot: { ...snapshot, members: [snapshot.members[0]!, member] },
    };
    vi.mocked(client.create).mockResolvedValueOnce(withMember);
    vi.mocked(client.kick)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockResolvedValueOnce(session);
    vi.mocked(client.getSession).mockResolvedValueOnce(withMember);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.kickMember('member-1');
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      session,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '已移除成员 成员',
    }));
    expect(client.kick).toHaveBeenCalledTimes(2);
    expect(client.kick).toHaveBeenLastCalledWith('room-1', 'member-1', 'epoch-1');
    expect(client.getSession).toHaveBeenCalledOnce();
  });

  it('leave 结果未知且 epoch 已轮换时按新权威重放离开意图并收敛终态', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    const recoveredSession = {
      ...memberSession,
      roomEpoch: 'epoch-2',
      snapshot: { ...memberSession.snapshot, roomEpoch: 'epoch-2' },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(client.leave)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_CONFLICT',
        409,
        '房间实例已变化，请重新进入房间后重试。',
      ))
      .mockResolvedValueOnce({ protocolVersion: 1, roomId: 'room-1', outcome: 'left' });
    vi.mocked(client.getSession).mockResolvedValueOnce(recoveredSession);
    await controller.join('room-1', '成员');

    await controller.leave();
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '已离开房间',
    }));
    expect(client.leave).toHaveBeenCalledTimes(3);
    expect(client.leave).toHaveBeenLastCalledWith('room-1', 'epoch-2');
    expect(client.getSession).toHaveBeenCalledOnce();
  });

  it('leave 对账在 epoch 轮换后重放仍未知时保持 unknown 并重建连接', async () => {
    const { client, controller } = createHarness();
    const memberSession = {
      ...session,
      self: {
        userId: 'member-1',
        role: 'member' as const,
        displayName: '成员',
        membershipState: 'active' as const,
      },
    };
    const recoveredSession = {
      ...memberSession,
      roomEpoch: 'epoch-2',
      snapshot: { ...memberSession.snapshot, roomEpoch: 'epoch-2' },
    };
    vi.mocked(client.join).mockResolvedValueOnce(memberSession);
    vi.mocked(client.leave)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_CONFLICT',
        409,
        '房间实例已变化，请重新进入房间后重试。',
      ))
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ));
    vi.mocked(client.getSession).mockResolvedValueOnce(recoveredSession);
    await controller.join('room-1', '成员');

    await controller.leave();
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      session: { roomId: 'room-1', roomEpoch: 'epoch-2' },
      managementOperation: 'leave',
      managementResultUnknown: true,
    }));
    expect(client.leave).toHaveBeenCalledTimes(3);
    expect(client.leave).toHaveBeenLastCalledWith('room-1', 'epoch-2');
    expect(client.getSession).toHaveBeenCalledOnce();
  });

  it('close 结果未知且 epoch 已轮换时按新权威重放关闭意图并收敛终态', async () => {
    const { client, controller } = createHarness();
    const recoveredSession = {
      ...session,
      roomEpoch: 'epoch-2',
      snapshot: { ...session.snapshot, roomEpoch: 'epoch-2' },
    };
    vi.mocked(client.close)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockResolvedValueOnce({ protocolVersion: 1, roomId: 'room-1', outcome: 'closed' });
    vi.mocked(client.getSession).mockResolvedValueOnce(recoveredSession);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.close();
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
      notice: '房间已关闭',
    }));
    expect(client.close).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenLastCalledWith('room-1', 'epoch-2');
    expect(client.getSession).toHaveBeenCalledOnce();
  });

  it('kick 结果未知且 epoch 已轮换时按新权威重放移除意图并重建控制传输', async () => {
    const { client, controller, sockets } = createHarness();
    const member = {
      userId: 'member-1',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    const withMember = {
      ...session,
      snapshot: { ...snapshot, members: [snapshot.members[0]!, member] },
    };
    const recoveredWithMember = {
      ...withMember,
      roomEpoch: 'epoch-2',
      snapshot: { ...withMember.snapshot, roomEpoch: 'epoch-2' },
    };
    const revokedSession = {
      ...session,
      roomEpoch: 'epoch-2',
      snapshot: {
        ...session.snapshot,
        roomEpoch: 'epoch-2',
        members: [snapshot.members[0]!, { ...member, membershipState: 'revoked' as const }],
      },
    };
    vi.mocked(client.create).mockResolvedValueOnce(withMember);
    vi.mocked(client.kick)
      .mockRejectedValueOnce(new ArenaRoomClientError(
        'ROOM_RESULT_UNKNOWN',
        null,
        '请求结果未知',
      ))
      .mockResolvedValueOnce(revokedSession);
    vi.mocked(client.getSession).mockResolvedValueOnce(recoveredWithMember);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.kickMember('member-1');
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    expect(sockets).toHaveLength(1);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      session: { roomEpoch: 'epoch-2' },
      managementOperation: null,
      managementResultUnknown: false,
      notice: '正在重新连接…',
    }));
    expect(controller.getSnapshot().session?.snapshot.members.find(
      (candidate) => candidate.userId === 'member-1',
    )?.membershipState).toBe('revoked');
    expect(client.kick).toHaveBeenCalledTimes(2);
    expect(client.kick).toHaveBeenLastCalledWith('room-1', 'member-1', 'epoch-2');
    expect(client.getSession).toHaveBeenCalledOnce();
    expect(client.issueTicket).toHaveBeenCalledTimes(2);
    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', {
      reconnect: { control: { roomEpoch: 'epoch-2', controlSeq: revokedSession.snapshot.controlSeq } },
    });
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(controller.getSnapshot().phase).toBe('connected');

    sockets[1]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-2',
      controlSeq: revokedSession.snapshot.controlSeq + 1,
      timestamp: '2026-08-28T00:06:00.000Z',
      type: 'room.member.joined',
      payload: {
        member: {
          userId: 'member-2',
          role: 'member' as const,
          displayName: '新成员',
          membershipState: 'active' as const,
          joinedAt: '2026-08-28T00:06:00.000Z',
        },
      },
    }));
    expect(controller.getSnapshot().session?.snapshot.members.some(
      (candidate) => candidate.userId === 'member-2',
    )).toBe(true);
  });

  it('kick 结果未知且 epoch 已轮换、目标已不在房间时安装新权威并重建控制传输', async () => {
    const { client, controller, sockets } = createHarness();
    const member = {
      userId: 'member-1',
      role: 'member' as const,
      displayName: '成员',
      membershipState: 'active' as const,
    };
    const withMember = {
      ...session,
      snapshot: { ...snapshot, members: [snapshot.members[0]!, member] },
    };
    const recoveredRevoked = {
      ...withMember,
      roomEpoch: 'epoch-2',
      snapshot: {
        ...withMember.snapshot,
        roomEpoch: 'epoch-2',
        controlSeq: 1,
        members: [snapshot.members[0]!, { ...member, membershipState: 'revoked' as const }],
      },
    };
    vi.mocked(client.create).mockResolvedValueOnce(withMember);
    vi.mocked(client.kick).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      null,
      '请求结果未知',
    ));
    vi.mocked(client.getSession).mockResolvedValueOnce(recoveredRevoked);
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.kickMember('member-1');
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    expect(sockets).toHaveLength(1);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      session: { roomEpoch: 'epoch-2' },
      managementOperation: null,
      managementResultUnknown: false,
    }));
    expect(client.kick).toHaveBeenCalledOnce();
    expect(client.issueTicket).toHaveBeenCalledTimes(2);
    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', {
      reconnect: { control: { roomEpoch: 'epoch-2', controlSeq: 1 } },
    });
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(controller.getSnapshot().phase).toBe('connected');
  });

  it('cancel-generation 结果未知且 epoch 已轮换时安装新权威并重建控制传输', async () => {
    const { client, controller, sockets } = createHarness();
    const generatingSession = {
      ...session,
      snapshot: { ...snapshot, activeGeneration: generationMirror },
    };
    const recoveredGenerating = {
      ...generatingSession,
      roomEpoch: 'epoch-2',
      snapshot: { ...generatingSession.snapshot, roomEpoch: 'epoch-2', controlSeq: 1 },
    };
    vi.mocked(client.create).mockResolvedValueOnce(generatingSession);
    vi.mocked(client.cancelGeneration).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      null,
      '请求结果未知',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    vi.mocked(client.getGenerationView).mockResolvedValueOnce({
      ...generationView,
      roomEpoch: 'epoch-2',
    });
    vi.mocked(client.getSession).mockResolvedValueOnce(recoveredGenerating);

    await controller.cancelGeneration();
    expect(controller.getSnapshot().managementResultUnknown).toBe(true);
    expect(sockets).toHaveLength(1);
    controller.reconnect();

    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      session: { roomEpoch: 'epoch-2' },
      managementOperation: null,
      managementResultUnknown: false,
    }));
    expect(client.issueTicket).toHaveBeenCalledTimes(2);
    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', {
      reconnect: { control: { roomEpoch: 'epoch-2', controlSeq: 1 } },
    });
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(controller.getSnapshot().phase).toBe('connected');
  });

  it('close 成功后立即结束本地房间会话', async () => {
    const { controller } = createHarness();
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.close();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      notice: '房间已关闭',
      managementOperation: null,
      managementResultUnknown: false,
      generation: { phase: 'idle', mirror: null, markdown: '' },
    });
  });

  it('close 直接返回 room not found 时结束失效的本地会话', async () => {
    const { client, controller } = createHarness();
    vi.mocked(client.close).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_NOT_FOUND',
      404,
      '房间不存在或已关闭',
    ));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    await controller.close();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      notice: '房间已结束',
      managementOperation: null,
      managementResultUnknown: false,
    });
  });

  it('close 使用同一管理锁，reset 后迟到结果不能污染新状态', async () => {
    const { client, controller } = createHarness();
    let resolveClose!: (value: { protocolVersion: 1; roomId: string; outcome: 'closed' }) => void;
    vi.mocked(client.close).mockImplementationOnce(() => new Promise((resolve) => {
      resolveClose = resolve;
    }));
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });

    const first = controller.close();
    const second = controller.close();
    expect(client.close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().managementOperation).toBe('close');

    controller.reset();
    resolveClose({ protocolVersion: 1, roomId: 'room-1', outcome: 'closed' });
    await Promise.all([first, second]);

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      session: null,
      managementOperation: null,
      managementResultUnknown: false,
    });
  });

  it('reconnect ticket 同时携带 control/story cursor，且 refresh/reconnect 只 GET 不 POST', async () => {
    const { client, controller, runNextTimer, sockets } = createHarness();
    vi.mocked(client.getGenerationView).mockResolvedValue({
      ...generationView,
      nextChunkSeq: 1,
    });
    await controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'room.snapshot',
      payload: {
        ...snapshot,
        controlSeq: 1,
        activeGeneration: generationMirror,
      },
    }));
    await vi.waitFor(() => expect(controller.getSnapshot().generation).toMatchObject({
      phase: 'running',
      storyCursor: { generationId: 'generation-1', chunkSeq: 0 },
    }));
    await Promise.resolve();
    sockets[0]!.closed(1013, 'try-again-later');
    await runNextTimer();

    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', {
      reconnect: {
        control: { roomEpoch: 'epoch-1', controlSeq: 1 },
        story: { generationId: 'generation-1', chunkSeq: 0 },
      },
    });
    expect(client.getGenerationView).toHaveBeenCalledTimes(2);
    expect(client.startGeneration).not.toHaveBeenCalled();
  });

  it('create 结果未知时冻结新意图，并以同一请求 ID 安全确认结果', async () => {
    const { client, controller } = createHarness();
    vi.mocked(client.create).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '请求可能已提交，请先确认房间状态，不要重复提交',
    ));
    const request = {
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' as const },
      sharedConfig,
    };

    await controller.create(request);
    await controller.create(request);

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unknown',
      notice: '请求可能已提交，请先确认房间状态，不要重复提交',
      unknownOperation: 'create',
    });

    await controller.retryUnknownOperation();
    expect(client.create).toHaveBeenCalledTimes(2);
    const firstRequest = vi.mocked(client.create).mock.calls[0]![0];
    const retryRequest = vi.mocked(client.create).mock.calls[1]![0];
    expect(firstRequest.creationRequestId).toBe('create-request-0001');
    expect(retryRequest).toEqual(firstRequest);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connecting',
      unknownOperation: null,
      session: { roomId: 'room-1' },
    });
  });

  it('join 结果未知先 GET session 有界确认，失败后也不重放 join POST', async () => {
    const { client, controller } = createHarness();
    vi.mocked(client.join).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      503,
      '加入请求结果未知，请先确认房间状态',
    ));
    vi.mocked(client.getSession).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_NOT_FOUND',
      404,
      '房间不存在',
    ));
    await controller.join('room-1', '成员');

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unknown',
      unknownOperation: 'join',
      notice: '加入请求结果未知，请先确认房间状态',
    });
    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.getSession).toHaveBeenCalledTimes(1);

    await controller.retryUnknownOperation();
    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.getSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connecting',
      unknownOperation: null,
      session: { roomId: 'room-1' },
    });
  });

  it('join POST 响应丢失但 session 已提交时由一次 GET 直接恢复', async () => {
    const { client, controller } = createHarness();
    vi.mocked(client.join).mockRejectedValueOnce(new ArenaRoomClientError(
      'ROOM_RESULT_UNKNOWN',
      null,
      '加入请求结果未知',
    ));

    await controller.join('room-1', '成员');

    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.getSession).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connecting',
      unknownOperation: null,
      session: { roomId: 'room-1' },
    });
  });

  it('按 close reason 区分 membership replacement、epoch recovery 与协议降级', async () => {
    const membership = createHarness();
    await membership.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    membership.sockets[0]!.open();
    membership.sockets[0]!.closed(1008, 'membership-revoked');
    expect(membership.controller.getSnapshot().phase).toBe('replacement');
    expect(membership.queued).toHaveLength(0);

    const epoch = createHarness();
    await epoch.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    epoch.sockets[0]!.open();
    epoch.sockets[0]!.closed(1008, 'room-epoch-stale');
    expect(epoch.controller.getSnapshot().phase).toBe('reconnecting');
    expect(epoch.queued).toHaveLength(1);

    const invalid = createHarness();
    await invalid.controller.create({
      displayName: '房主',
      directory: { title: '测试房', visibility: 'public' },
      sharedConfig,
    });
    invalid.sockets[0]!.open();
    invalid.sockets[0]!.closed(1008, 'invalid-message');
    expect(invalid.controller.getSnapshot()).toMatchObject({
      phase: 'degraded',
      notice: '房间运行时暂不可用，正在重试',
    });
    expect(invalid.queued).toHaveLength(1);
  });
});


describe('Room controller ephemeral presence', () => {
  const presence = {
    protocolVersion: 1, type: 'room.presence', roomId: 'room-1', roomEpoch: 'epoch-1',
    onlineUserIds: ['user-host'],
  };
  it('接收完整在线投影，不推进controlSeq；拒绝旧epoch，断线清空并可重连恢复', async () => {
    const { controller, sockets, runNextTimer } = createHarness();
    await controller.join('room-1', '房主');
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify(presence));
    expect(controller.getSnapshot().presence).toEqual(presence);
    expect(controller.getSnapshot().session?.snapshot.controlSeq).toBe(0);
    sockets[0]!.message(JSON.stringify({ ...presence, roomEpoch: 'old-epoch', onlineUserIds: [] }));
    expect(controller.getSnapshot().presence).toEqual(presence);
    const staleMessage = sockets[0]!.onmessage;
    sockets[0]!.closed(1006);
    expect(controller.getSnapshot().presence).toBeNull();
    await runNextTimer();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(controller.getSnapshot().presence).toBeNull();
    staleMessage?.({ data: JSON.stringify(presence) });
    expect(controller.getSnapshot().presence).toBeNull();
    sockets[1]!.message(JSON.stringify(presence));
    expect(controller.getSnapshot().presence).toEqual(presence);
    controller.reset();
    expect(controller.getSnapshot().presence).toBeNull();
    controller.dispose();
  });
  it('协商旧v1时保持可用，不从membership推断在线', async () => {
    const { controller, sockets } = createHarness();
    await controller.join('room-1', '房主');
    sockets[0]!.protocol = 'mahoshojo.arena-room.v1';
    sockets[0]!.open();
    expect(controller.getSnapshot().phase).toBe('connected');
    expect(controller.getSnapshot().presence).toBeNull();
    sockets[0]!.message(JSON.stringify(presence));
    expect(controller.getSnapshot().presence).toBeNull();
    controller.dispose();
  });
  it('离开成员从snapshot移除，成员轮换不会积累revoked条目突破容量', async () => {
    const { controller, sockets } = createHarness();
    await controller.join('room-1', '房主');
    sockets[0]!.open();
    for (let index = 1; index <= 40; index += 1) {
      const member = { userId: `member-${index}`, role: 'member', displayName: '成员', membershipState: 'active' };
      const event = { protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', timestamp: '2026-09-16T10:00:00.000Z' };
      sockets[0]!.message(JSON.stringify({ ...event, type: 'room.member.joined', controlSeq: index * 2 - 1, payload: { member } }));
      sockets[0]!.message(JSON.stringify({ ...event, type: 'room.member.left', controlSeq: index * 2,
        payload: { member: { ...member, membershipState: 'revoked' } } }));
    }
    expect(controller.getSnapshot().session?.snapshot.members).toEqual(snapshot.members);
    expect(controller.getSnapshot().session?.snapshot.controlSeq).toBe(80);
    controller.dispose();
  });
});


describe('房间配置发布拒绝与权威恢复', () => {
  const openHostRoom = async () => {
    const harness = createHarness();
    await harness.controller.create({ displayName: '房主', directory: { title: '测试房', visibility: 'public' }, sharedConfig });
    harness.sockets[0]!.open();
    return harness;
  };
  const publishRequest = {
    expectedRoomEpoch: 'epoch-1', expectedRevision: 0, expectedControlSeq: 0,
    sharedConfig: { ...sharedConfig, userGuidance: '本地未发布草稿' },
  };

  it.each([
    ['ROOM_CONFLICT', 409, '房间配置已发生变化'],
    ['ROOM_REFERENCE_STALE', 409, '房间配置引用的数据卡已更新，请重新选择'],
    ['ROOM_REFERENCE_DENIED', 403, '房间配置引用的数据卡当前不可读取'],
  ])('明确返回 %s 拒绝，不把错误包装成未知结果或重放发布', async (code, status, message) => {
    const { controller, client } = await openHostRoom();
    const error = new ArenaRoomClientError(code, status, message);
    vi.mocked(client.publishConfig).mockRejectedValueOnce(error);
    expect(await controller.publishConfig(publishRequest)).toEqual({ kind: 'rejected', error });
    expect(controller.getSnapshot()).toMatchObject({
      error: message, configPublishPending: false, configPublishResultUnknown: false,
      session: { snapshot: { revision: 0, sharedConfig } },
    });
    expect(client.publishConfig).toHaveBeenCalledOnce();
    expect(client.getSession).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('同配置发布保持 revision 时返回确认，而不是拒绝或未知', async () => {
    const { controller } = await openHostRoom();
    expect(await controller.publishConfig({ ...publishRequest, sharedConfig })).toEqual({ kind: 'confirmed', session });
    expect(controller.getSnapshot().configPublishResultUnknown).toBe(false);
    controller.dispose();
  });

  it('本地 controlSeq 已前进时拒绝旧请求，不发送可预知冲突的 POST', async () => {
    const { controller, client, sockets } = await openHostRoom();
    sockets[0]!.message(JSON.stringify({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1',
      controlSeq: 1, timestamp: '2026-10-11T15:00:00.000Z', type: 'room.snapshot', payload: { ...snapshot, controlSeq: 1 } }));
    expect(await controller.publishConfig(publishRequest)).toMatchObject({ kind: 'rejected', error: { code: 'ROOM_CONFLICT' } });
    expect(client.publishConfig).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('完整发布响应收敛期间到达的控制事件，并推进复制游标', async () => {
    const { controller, client, sockets, runNextTimer } = await openHostRoom();
    let resolve!: (value: typeof session) => void;
    vi.mocked(client.publishConfig).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = controller.publishConfig(publishRequest);
    const member = { userId: 'new-member', role: 'member' as const, displayName: '新成员', membershipState: 'active' as const };
    sockets[0]!.message(JSON.stringify({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1',
      controlSeq: 1, timestamp: '2026-10-11T15:00:00.000Z', type: 'room.member.joined', payload: { member } }));
    const authoritative = { ...session, snapshot: { ...snapshot, revision: 1, controlSeq: 2,
      sharedConfig: publishRequest.sharedConfig, members: [...snapshot.members, member] } };
    resolve(authoritative);
    expect(await pending).toEqual({ kind: 'confirmed', session: authoritative });
    controller.reconnect();
    await runNextTimer();
    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', expect.objectContaining({ reconnect: { control: { roomEpoch: 'epoch-1', controlSeq: 2 } } }));
    controller.dispose();
  });

  it('读取并安装最新完整 session，随后发布由用户重新发起', async () => {
    const { controller, client } = await openHostRoom();
    const error = new ArenaRoomClientError('ROOM_CONFLICT', 409, '房间配置已发生变化');
    vi.mocked(client.publishConfig).mockRejectedValueOnce(error);
    await controller.publishConfig(publishRequest);
    const authoritative = { ...session, snapshot: { ...snapshot, revision: 2, controlSeq: 4,
      sharedConfig: { ...sharedConfig, userGuidance: '服务器最新配置' } } };
    vi.mocked(client.getSession).mockResolvedValueOnce(authoritative);
    expect(await controller.refreshSession()).toEqual(authoritative);
    expect(controller.getSnapshot()).toMatchObject({ session: authoritative, error: null, configPublishResultUnknown: false });
    expect(client.getSession).toHaveBeenCalledWith('room-1');
    expect(client.publishConfig).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('未知结果经只读 session 核对仍未知，不重放原发布请求', async () => {
    const { controller, client } = await openHostRoom();
    const error = new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '结果未知');
    vi.mocked(client.publishConfig).mockRejectedValueOnce(error);
    expect(await controller.publishConfig(publishRequest)).toEqual({ kind: 'unknown', error });
    expect(controller.getSnapshot().configPublishResultUnknown).toBe(true);
    await controller.refreshSession();
    // GET 描述当前配置，不能裁定先前 POST 的结果。
    expect(controller.getSnapshot()).toMatchObject({ configPublishResultUnknown: true, configPublishPending: false });
    expect(client.publishConfig).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('同 revision 的完整 session 刷新控制序号与成员，并以新游标恢复复制', async () => {
    const { controller, client, runNextTimer } = await openHostRoom();
    const member = { userId: 'new-member', role: 'member' as const, displayName: '新成员', membershipState: 'active' as const };
    const authoritative = { ...session, snapshot: { ...snapshot, controlSeq: 4, members: [...snapshot.members, member] } };
    vi.mocked(client.getSession).mockResolvedValueOnce(authoritative);
    await controller.refreshSession();
    expect(controller.getSnapshot().session).toEqual(authoritative);
    controller.reconnect();
    await runNextTimer();
    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', expect.objectContaining({ reconnect: { control: { roomEpoch: 'epoch-1', controlSeq: 4 } } }));
    controller.dispose();
  });

  it('读取在途时 WSS 已安装更新配置，较旧 GET 不回退状态', async () => {
    const { controller, client, sockets } = await openHostRoom();
    let resolve!: (value: typeof session) => void;
    vi.mocked(client.getSession).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = controller.refreshSession();
    const newer = { ...snapshot, revision: 1, controlSeq: 2, sharedConfig: publishRequest.sharedConfig };
    sockets[0]!.message(JSON.stringify({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1',
      controlSeq: 2, timestamp: '2026-10-11T15:00:00.000Z', type: 'room.snapshot', payload: newer }));
    resolve(session);
    expect((await pending).snapshot).toEqual(newer);
    expect(controller.getSnapshot().session?.snapshot).toEqual(newer);
    controller.dispose();
  });

  it.each(['room', 'self', 'membership', 'same-revision-config', 'crossed-cursors'] as const)('拒绝无效 refresh authority：%s', async (fault) => {
    const { controller, client } = await openHostRoom();
    const authoritative = {
      ...session,
      ...(fault === 'room' ? { roomId: 'different-room' } : {}),
      self: { ...session.self, ...(fault === 'self' ? { userId: 'other-host' } : {}),
        ...(fault === 'membership' ? { membershipState: 'revoked' as const } : {}) },
      snapshot: { ...snapshot,
        ...(fault === 'same-revision-config' ? { sharedConfig: publishRequest.sharedConfig } : {}),
        ...(fault === 'crossed-cursors' ? { revision: 1, controlSeq: -1 } : {}) },
    };
    vi.mocked(client.getSession).mockResolvedValueOnce(authoritative);
    await expect(controller.refreshSession()).rejects.toBeInstanceOf(ArenaRoomClientError);
    expect(controller.getSnapshot().session).toEqual(session);
    controller.dispose();
  });

  it('session 读取失败保留旧状态与发布未知标记', async () => {
    const { controller, client } = await openHostRoom();
    vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '结果未知'));
    await controller.publishConfig(publishRequest);
    const error = new ArenaRoomClientError('ROOM_UNAVAILABLE', 503, '读取失败');
    vi.mocked(client.getSession).mockRejectedValueOnce(error);
    await expect(controller.refreshSession()).rejects.toBe(error);
    expect(controller.getSnapshot()).toMatchObject({ configPublishResultUnknown: true, session });
    controller.dispose();
  });

  it.each(['reset', 'dispose', 'access'] as const)('读取期间 %s 后不安装旧身份响应', async (action) => {
    const { controller, client } = await openHostRoom();
    let resolve!: (value: typeof session) => void;
    vi.mocked(client.getSession).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = controller.refreshSession();
    const failure = expect(pending).rejects.toBeInstanceOf(ArenaRoomClientError);
    if (action === 'access') controller.setAccess({ enabled: true, authenticated: false });
    else controller[action]();
    const before = controller.getSnapshot();
    resolve({ ...session, snapshot: { ...snapshot, revision: 1, controlSeq: 1, sharedConfig: publishRequest.sharedConfig } });
    await failure;
    expect(controller.getSnapshot()).toEqual(before);
    controller.dispose();
  });

  it('读取期间有新的配置发布，不以 GET 覆盖发布或清除其围栏', async () => {
    const { controller, client } = await openHostRoom();
    let resolve!: (value: typeof session) => void;
    vi.mocked(client.getSession).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = controller.refreshSession();
    const failure = expect(pending).rejects.toMatchObject({ code: 'ROOM_CONFLICT' });
    const published = { ...session, snapshot: { ...snapshot, revision: 1, controlSeq: 1, sharedConfig: publishRequest.sharedConfig } };
    vi.mocked(client.publishConfig).mockResolvedValueOnce(published);
    await controller.publishConfig(publishRequest);
    resolve(session);
    await failure;
    expect(controller.getSnapshot().session).toEqual(published);
    controller.dispose();
  });

  it('refresh 接受服务器恢复的新 epoch，并重建 socket 复制通道', async () => {
    const { controller, client, sockets } = await openHostRoom();
    const authoritative = { ...session, roomEpoch: 'epoch-2', snapshot: { ...snapshot, roomEpoch: 'epoch-2', revision: 0, controlSeq: 0 } };
    vi.mocked(client.getSession).mockResolvedValueOnce(authoritative);
    await controller.refreshSession();
    await vi.waitFor(() => expect(client.issueTicket).toHaveBeenCalledTimes(2));
    expect(controller.getSnapshot().session).toEqual(authoritative);
    expect(sockets[0]!.onmessage).toBeNull();
    expect(client.issueTicket).toHaveBeenLastCalledWith('room-1', expect.objectContaining({ reconnect: { control: { roomEpoch: 'epoch-2', controlSeq: 0 } } }));
    controller.dispose();
  });
  it('结束跟踪必须匹配原 ID，普通 GET 不开写门，专用 fresh read 后才允许显式新发布', async () => {
    const { controller, client } = await openHostRoom();
    vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '未知'));
    await controller.publishConfig(publishRequest);
    const id = controller.getSnapshot().configTracking!.id;
    controller.endConfigPublishTracking('stale-id');
    expect(controller.getSnapshot().configTracking).toMatchObject({ id, phase: 'unknown' });
    await controller.checkConfigPublish();
    expect(controller.getSnapshot().configTracking).toMatchObject({ id, phase: 'unknown', observation: 'target-differs', checking: false });
    controller.endConfigPublishTracking(id);
    expect(controller.getSnapshot().configTracking).toMatchObject({ id, phase: 'ended-needs-read' });
    await controller.refreshSession();
    expect(await controller.publishConfig(publishRequest)).toMatchObject({ kind: 'unknown' });
    expect(client.publishConfig).toHaveBeenCalledOnce();
    await controller.readConfigAfterEnd('stale-id');
    expect(controller.getSnapshot().configTracking?.phase).toBe('ended-needs-read');
    await controller.readConfigAfterEnd(id);
    expect(controller.getSnapshot().configTracking).toBeNull();
    expect(client.publishConfig).toHaveBeenCalledOnce();
    vi.mocked(client.publishConfig).mockResolvedValueOnce({ ...session, snapshot: { ...snapshot, revision: 1, controlSeq: 1, sharedConfig: publishRequest.sharedConfig } });
    expect(await controller.publishConfig(publishRequest)).toMatchObject({ kind: 'confirmed' });
    controller.dispose();
  });

  it('结束前的在途核对不能替代结束后 fresh read，旧 ID 不能结束新跟踪', async () => {
    const { controller, client } = await openHostRoom();
    vi.mocked(client.publishConfig).mockRejectedValue(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '未知'));
    await controller.publishConfig(publishRequest);
    const oldId = controller.getSnapshot().configTracking!.id;
    let resolve!: (value: typeof session) => void;
    vi.mocked(client.getSession).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const checking = controller.checkConfigPublish();
    controller.endConfigPublishTracking(oldId);
    resolve(session);
    await checking;
    expect(controller.getSnapshot().configTracking).toMatchObject({ id: oldId, phase: 'ended-needs-read' });
    await controller.readConfigAfterEnd(oldId);
    await controller.publishConfig(publishRequest);
    const newId = controller.getSnapshot().configTracking!.id;
    expect(newId).not.toBe(oldId);
    controller.endConfigPublishTracking(oldId);
    expect(controller.getSnapshot().configTracking).toMatchObject({ id: newId, phase: 'unknown' });
    controller.dispose();
  });

  it('旧目标迟到的 WSS 只观察当前配置，不清新跟踪或冒认新请求成功', async () => {
    const { controller, client, sockets } = await openHostRoom();
    vi.mocked(client.publishConfig).mockRejectedValue(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '未知'));
    await controller.publishConfig(publishRequest);
    const oldId = controller.getSnapshot().configTracking!.id;
    controller.endConfigPublishTracking(oldId);
    await controller.readConfigAfterEnd(oldId);
    const nextRequest = { ...publishRequest, sharedConfig: { ...publishRequest.sharedConfig, userGuidance: '新的显式目标' } };
    await controller.publishConfig(nextRequest);
    const newId = controller.getSnapshot().configTracking!.id;
    sockets[0]!.message(JSON.stringify({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1',
      controlSeq: 1, timestamp: '2026-10-15T18:00:00.000Z', type: 'room.config.updated',
      payload: { revision: 1, sharedConfig: publishRequest.sharedConfig } }));
    expect(controller.getSnapshot()).toMatchObject({ configPublishResultUnknown: true,
      configTracking: { id: newId, phase: 'unknown', observation: 'target-differs', target: { request: nextRequest } } });
    expect(client.publishConfig).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('旧 check 结算不能清除结束后 fresh read 的 busy 或挂旧错误', async () => {
    const { controller, client } = await openHostRoom();
    vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '未知'));
    await controller.publishConfig(publishRequest);
    const id = controller.getSnapshot().configTracking!.id;
    let finishCheck!: (value: typeof session) => void;
    let finishRead!: (value: typeof session) => void;
    vi.mocked(client.getSession)
      .mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const checking = controller.checkConfigPublish();
    controller.endConfigPublishTracking(id);
    const reading = controller.readConfigAfterEnd(id);
    finishCheck(session);
    await checking;
    expect(controller.getSnapshot()).toMatchObject({ error: null,
      configTracking: { id, phase: 'ended-needs-read', checking: true } });
    finishRead(session);
    await reading;
    expect(controller.getSnapshot().configTracking).toBeNull();
    controller.dispose();
  });

  it('保留草稿标志不由 GET 清除，只接受匹配权威的显式同步完成', async () => {
    const { controller, client } = await openHostRoom();
    vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '未知'));
    await controller.publishConfig(publishRequest);
    controller.acknowledgeConfigDraftSync(session);
    expect(controller.getSnapshot().configDraftPreserved).toBe(true);
    const id = controller.getSnapshot().configTracking!.id;
    controller.endConfigPublishTracking(id);
    await controller.readConfigAfterEnd(id);
    await controller.refreshSession();
    expect(controller.getSnapshot().configDraftPreserved).toBe(true);
    controller.acknowledgeConfigDraftSync({ ...session, roomEpoch: 'stale-epoch' });
    expect(controller.getSnapshot().configDraftPreserved).toBe(true);
    controller.acknowledgeConfigDraftSync(session);
    expect(controller.getSnapshot().configDraftPreserved).toBe(false);
    controller.dispose();
  });

  it('结束后的 fresh read 身份失效不得恢复写门或认领旧目标', async () => {
    let current = true;
    const { controller, client } = createHarness({ identity: { epoch: 1, isCurrent: () => current } });
    await controller.join('room-1', '房主');
    vi.mocked(client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '未知'));
    await controller.publishConfig(publishRequest);
    const id = controller.getSnapshot().configTracking!.id;
    controller.endConfigPublishTracking(id);
    let resolve!: (value: typeof session) => void;
    vi.mocked(client.getSession).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const reading = controller.readConfigAfterEnd(id);
    current = false;
    resolve(session);
    await reading;
    expect(controller.getSnapshot()).toMatchObject({ session: null, configTracking: null });
    controller.dispose();
  });
});


describe('配置 unknown 的只读观察边界', () => {
  const paths = ['room.snapshot', 'room.config.updated', 'reconcileUnknownMutations', 'refreshSession'] as const;
  const observations = ['same-target', 'different-target', 'original-revision'] as const;
  const desired = { ...sharedConfig, userGuidance: '待确认的发布目标' };
  const request = {
    expectedRoomEpoch: 'epoch-1', expectedRevision: 0, expectedControlSeq: 0,
    sharedConfig: desired,
  };
  const openRoom = async () => {
    const harness = createHarness();
    await harness.controller.create({ displayName: '房主', directory: { title: '测试房', visibility: 'public' }, sharedConfig });
    harness.sockets[0]!.open();
    return harness;
  };
  const observe = async (
    harness: ReturnType<typeof createHarness>,
    path: typeof paths[number],
    authoritative: typeof session,
  ) => {
    if (path === 'refreshSession') {
      vi.mocked(harness.client.getSession).mockResolvedValueOnce(authoritative);
      await harness.controller.refreshSession();
    } else if (path === 'reconcileUnknownMutations') {
      vi.mocked(harness.client.getSession).mockResolvedValueOnce(authoritative);
      harness.controller.reconnect();
      await vi.waitFor(() => expect(harness.client.issueTicket).toHaveBeenCalledTimes(2));
    } else {
      harness.sockets[0]!.message(JSON.stringify({
        protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1',
        controlSeq: authoritative.snapshot.controlSeq, timestamp: '2026-10-15T18:00:00.000Z',
        type: path,
        payload: path === 'room.snapshot' ? authoritative.snapshot : {
          revision: authoritative.snapshot.revision, sharedConfig: authoritative.snapshot.sharedConfig,
        },
      }));
    }
  };

  it.each(paths.flatMap((path) => observations
    // config.updated 表示新配置 revision；原 revision 的合法观察走 snapshot 或 GET。
    .filter((observation) => path !== 'room.config.updated' || observation !== 'original-revision')
    .map((observation) => ({ path, observation }))))(
    '$path 观察 $observation 只更新房间状态，不能裁定原 POST', async ({ path, observation }) => {
      const harness = await openRoom();
      const { controller, client } = harness;
      const error = new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '发布结果仍未知，请勿重复提交');
      vi.mocked(client.publishConfig).mockRejectedValueOnce(error);
      try {
        expect(await controller.publishConfig(request)).toEqual({ kind: 'unknown', error });
        expect(controller.getSnapshot().configPublishResultUnknown).toBe(true);
        const authoritative = { ...session, snapshot: {
          ...snapshot,
          revision: observation === 'original-revision' ? 0 : 1,
          controlSeq: 1,
          sharedConfig: observation === 'same-target' ? desired
            : observation === 'different-target' ? { ...sharedConfig, userGuidance: '另一发布者的当前配置' } : sharedConfig,
        } };
        const notices: Array<string | null> = [];
        const unsubscribe = controller.subscribe(() => notices.push(controller.getSnapshot().notice));
        await observe(harness, path, authoritative);
        unsubscribe();
        expect(controller.getSnapshot().session?.snapshot).toEqual(authoritative.snapshot);
        expect(client.publishConfig).toHaveBeenCalledOnce();
        expect.soft(controller.getSnapshot()).toMatchObject({ configPublishPending: false, configPublishResultUnknown: true });
        expect.soft(notices.filter((notice) => /已确认配置同步完成|配置同步未生效|房间配置已更新/u.test(notice ?? ''))).toEqual([]);
      } finally {
        controller.dispose();
      }
    },
  );

  it.each(['room.snapshot', 'room.config.updated', 'refreshSession'] as const)(
    '%s 无 unknown 时仍正常同步权威配置', async (path) => {
      const harness = await openRoom();
      try {
        const authoritative = { ...session, snapshot: { ...snapshot, revision: 1, controlSeq: 1, sharedConfig: desired } };
        await observe(harness, path, authoritative);
        expect(harness.controller.getSnapshot()).toMatchObject({
          session: authoritative, configPublishPending: false, configPublishResultUnknown: false,
        });
        expect(harness.client.publishConfig).not.toHaveBeenCalled();
      } finally {
        harness.controller.dispose();
      }
    },
  );
});

describe('Arena Room identity invalidation', () => {
  it.each(['logout', 'account-switch'] as const)('%s 后旧配置目标和跟踪对新身份不可见', async (change) => {
    const key = authIdentity.AUTH_STORAGE_KEY;
    const previous = localStorage.getItem(key);
    localStorage.setItem(key, 'tracking-owner-a');
    const first = createHarness({ identity: authIdentity.captureAuthIdentity() });
    try {
      await first.controller.join('room-1', '房主');
      vi.mocked(first.client.publishConfig).mockRejectedValueOnce(new ArenaRoomClientError('ROOM_RESULT_UNKNOWN', 503, '未知'));
      await first.controller.publishConfig({ expectedRoomEpoch: 'epoch-1', expectedRevision: 0, expectedControlSeq: 0,
        sharedConfig: { ...sharedConfig, userGuidance: '账号 A 原目标，不得泄漏给新身份' } });
      expect(first.controller.getSnapshot().configTracking?.target).not.toBeNull();
      if (change === 'logout') localStorage.removeItem(key);
      else localStorage.setItem(key, 'tracking-owner-b');
      expect(first.controller.getSnapshot()).toMatchObject({ session: null, configTracking: null,
        configPublishResultUnknown: false, configDraftPreserved: false });
      await first.controller.checkConfigPublish();
      expect(first.client.getSession).not.toHaveBeenCalled();
      const next = createHarness({ identity: authIdentity.captureAuthIdentity() });
      expect(next.controller.getSnapshot()).toMatchObject({ session: null, configTracking: null,
        configPublishResultUnknown: false, configDraftPreserved: false });
      next.controller.dispose();
    } finally {
      first.controller.dispose();
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it('只读 snapshot 不持有身份订阅，真正激活后 dispose 释放监听器', () => {
    const actualSubscribe = authIdentity.subscribeAuthIdentity;
    const unsubscribed = vi.fn();
    const subscribe = vi.spyOn(authIdentity, 'subscribeAuthIdentity').mockImplementation((listener) => {
      const stop = actualSubscribe(listener);
      return () => { unsubscribed(); stop(); };
    });
    let current = true;
    const discarded = createHarness({ identity: { epoch: 1, isCurrent: () => current } });
    discarded.controller.getSnapshot();
    discarded.controller.getSnapshot();
    expect(subscribe).not.toHaveBeenCalled();
    current = false;
    expect(discarded.controller.getSnapshot()).toMatchObject({ phase: 'unauthenticated', session: null });
    expect(subscribe).not.toHaveBeenCalled();
    discarded.controller.dispose();

    const active = createHarness();
    const stop = active.controller.subscribe(vi.fn());
    active.controller.getSnapshot();
    active.controller.setAccess({ enabled: true, authenticated: true });
    expect(subscribe).toHaveBeenCalledOnce();
    stop();
    active.controller.dispose();
    expect(unsubscribed).toHaveBeenCalledOnce();
    subscribe.mockRestore();
  });

  it.each(['action', 'socket'] as const)('raw storage 变化后的纯 snapshot 不触发清理，随后 %s 边界安全清理', async (boundary) => {
    const storageKey = authIdentity.AUTH_STORAGE_KEY;
    const previousAuth = localStorage.getItem(storageKey);
    localStorage.setItem(storageKey, 'account-a');
    const { controller, client, sockets, queued } = createHarness({ identity: authIdentity.captureAuthIdentity() });
    const listener = vi.fn();
    controller.subscribe(listener);
    try {
      await controller.join('room-1', '房主');
      const socket = sockets[0]!;
      socket.open();
      const onmessage = socket.onmessage!;
      listener.mockClear();
      localStorage.setItem(storageKey, 'account-b');
      // 不派发 storage event，也不调用 capture/observe：getter 自己返回稳定 fail-closed 投影。
      const rejected = controller.getSnapshot();
      expect(rejected).toMatchObject({ phase: 'unauthenticated', session: null, generation: { mirror: null } });
      expect(controller.getSnapshot()).toBe(rejected);
      expect(controller.getSnapshot()).toBe(rejected);
      expect(socket.close).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();

      if (boundary === 'action') await controller.leave();
      else onmessage({ data: 'old frame must not be processed' });
      expect(client.leave).not.toHaveBeenCalled();
      expect(client.join).toHaveBeenCalledOnce();
      expect(client.issueTicket).toHaveBeenCalledOnce();
      expect(socket.close).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledOnce();
      expect(queued).toHaveLength(0);
      expect(controller.getSnapshot()).toBe(rejected);
    } finally {
      controller.dispose();
      if (previousAuth === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previousAuth);
    }
  });

  it('旧 controller 操作清空权威且不会用新身份退出同一房间', async () => {
    let current = true;
    const { controller, client, sockets } = createHarness({ identity: { epoch: 1, isCurrent: () => current } });
    await controller.join('room-1', '房主');
    sockets[0]!.open();
    current = false;
    await controller.leave();
    expect(client.leave).not.toHaveBeenCalled();
    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'unauthenticated', session: null });
    controller.setAccess({ enabled: true, authenticated: true });
    controller.reset();
    await controller.join('room-1', '新身份');
    expect(client.join).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().session).toBeNull();
    controller.dispose();
  });

  it('join 晚响应不再申请 ticket 或打开 socket', async () => {
    let current = true;
    let complete!: (value: ArenaRoomSessionResponse) => void;
    const { controller, client, sockets } = createHarness({ identity: { epoch: 1, isCurrent: () => current } });
    vi.mocked(client.join).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const pending = controller.join('room-1', '房主');
    current = false;
    complete(session);
    await pending;
    expect(client.issueTicket).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(controller.getSnapshot().session).toBeNull();
    controller.dispose();
  });

  it('ticket 晚响应与已经捕获的 socket 回调都被身份围栏拒绝', async () => {
    let current = true;
    const first = createHarness({ identity: { epoch: 1, isCurrent: () => current } });
    await first.controller.join('room-1', '房主');
    const socket = first.sockets[0]!;
    const onopen = socket.onopen!;
    const onmessage = socket.onmessage!;
    const onclose = socket.onclose!;
    const onerror = socket.onerror!;
    current = false;
    onopen();
    onmessage({ data: 'invalid old frame' });
    onerror();
    onclose({ code: 1006, reason: 'old transport' });
    expect(first.controller.getSnapshot().session).toBeNull();
    expect(first.queued).toHaveLength(0);
    expect(socket.close).toHaveBeenCalled();
    first.controller.dispose();

    current = true;
    let complete!: (value: ReturnType<typeof ticket>) => void;
    const second = createHarness({ identity: { epoch: 2, isCurrent: () => current } });
    vi.mocked(second.client.issueTicket).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const pending = second.controller.join('room-1', '房主');
    await Promise.resolve();
    current = false;
    complete(ticket('late-ticket'));
    await pending;
    expect(second.sockets).toHaveLength(0);
    expect(second.controller.getSnapshot().session).toBeNull();
    second.controller.dispose();
  });
});
