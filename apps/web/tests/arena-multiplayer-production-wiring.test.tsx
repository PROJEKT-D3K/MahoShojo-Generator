// @vitest-environment jsdom

import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ROOM_MEMBERS, type ArenaRoomProposalSubmitRequest } from '@mahoshojo/contracts/arena-room';

import {
  ArenaMultiplayerContextPanel,
  type ArenaMultiplayerPanelProps,
} from '@/components/arena/multiplayer/ArenaMultiplayerPanel';
import { ArenaEditorWorkspaceBoundary } from '@/components/arena/multiplayer/ArenaRoomProposalWorkspace';
import {
  ArenaRoomProvider,
  useArenaRoomContext,
} from '@/components/arena/multiplayer/useArenaRoom';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { authStorage } from '@/lib/auth';
import type { ArenaRoomController } from '@/lib/arena-room/controller';
import { beginAuthIdentityTransition } from '@/lib/auth-identity';
import { createRoomInviteScope } from '@mahoshojo/ui-web/arena-room';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sharedConfig = {
  battleMode: 'classic',
  combatants: [{
    key: 'host-local:character:1',
    displayName: '角色',
    type: 'magical-girl',
    source: 'host-local',
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
};

const host = {
  userId: 'user-host',
  role: 'host' as const,
  displayName: '房主',
  membershipState: 'active' as const,
};

const sessionFor = (role: 'host' | 'member') => {
  const self = role === 'host' ? host : {
    userId: 'user-member',
    role: 'member' as const,
    displayName: '成员',
    membershipState: 'active' as const,
  };
  const snapshot = {
    protocolVersion: 1,
    schemaVersion: 1,
    roomId: 'room-1',
    roomEpoch: 'epoch-1',
    revision: 0,
    controlSeq: 0,
    sharedConfig,
    members: role === 'host' ? [host] : [host, self],
    proposals: [],
    activeGeneration: null,
  };
  return {
    protocolVersion: 1,
    roomId: 'room-1',
    roomEpoch: 'epoch-1',
    self,
    snapshot,
  };
};

class WiringSocket {
  static instances: WiringSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  readonly protocol: string;

  constructor(readonly url: string, readonly offeredProtocols: string | string[]) {
    this.protocol = Array.isArray(offeredProtocols) ? offeredProtocols[0]! : offeredProtocols;
    WiringSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  closed(code: number, reason: string): void {
    this.onclose?.({ code, reason });
  }
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let inviteController: ArenaRoomController;
let renderedRoomIds: (string | null)[];
let inviteClipboardDescriptor: PropertyDescriptor | undefined;
let inviteExecCommandDescriptor: PropertyDescriptor | undefined;
const InviteControllerProbe = () => {
  const runtime = useArenaRoomContext();
  useLayoutEffect(() => {
    if (!runtime) return;
    inviteController = runtime.controller;
    renderedRoomIds.push(runtime.state.session?.roomId ?? null);
  }, [runtime]);
  return null;
};

const props = {
  enabled: true,
  origin: 'http://127.0.0.1:8787',
  authLoading: false,
  isAuthenticated: true,
  displayName: '测试玩家',
};

const requestPath = (input: string): string => new URL(input, 'http://test.local').pathname;

const PanelUiProbe = () => {
  const runtime = useArenaRoomContext();
  if (!runtime) return null;
  return (
    <>
      <button type="button" onClick={() => runtime.panelUi.setProposalsOpen(true)}>
        probe-open-proposals
      </button>
      <button type="button" onClick={() => runtime.panelUi.setConfigOpen(true)}>
        probe-open-config
      </button>
    </>
  );
};

const productionTree = (panelProps: ArenaMultiplayerPanelProps) => (
  <ArenaRoomProvider
    enabled={panelProps.enabled}
    authenticated={panelProps.isAuthenticated && !panelProps.authLoading}
    origin={panelProps.origin}
  >
    <QueryClientProvider client={queryClient}>
      <ArenaMultiplayerContextPanel {...panelProps} />
      <InviteControllerProbe />
      <ArenaEditorWorkspaceBoundary>
        <div data-arena-editor-placeholder="v1" />
      </ArenaEditorWorkspaceBoundary>
    </QueryClientProvider>
  </ArenaRoomProvider>
);

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const button = (label: string): HTMLButtonElement => {
  const match = [...document.body.querySelectorAll('button')]
    .find((candidate) => (
      candidate.textContent?.trim() === label
      || candidate.getAttribute('aria-label')?.split('，')[0] === label
    ));
  if (!(match instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return match;
};

const enterJoinCode = async (): Promise<void> => {
  if (!document.body.querySelector('#arena-room-join-code')) {
    await act(async () => button('打开多人房间').click());
    await flush();
  }
  const input = document.body.querySelector<HTMLInputElement>('#arena-room-join-code');
  if (!input) throw new Error('join input missing');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      ?.call(input, 'room-1');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const setTextField = async (id: string, value: string): Promise<void> => {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (!input) throw new Error(`text field not found: ${id}`);
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      ?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  WiringSocket.instances = [];
  renderedRoomIds = [];
  inviteClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  inviteExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
  vi.stubGlobal('WebSocket', WiringSocket);
  vi.spyOn(authStorage, 'getAuthHeader').mockResolvedValue('Bearer verified-key');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (inviteClipboardDescriptor) Object.defineProperty(navigator, 'clipboard', inviteClipboardDescriptor); else Reflect.deleteProperty(navigator, 'clipboard');
  if (inviteExecCommandDescriptor) Object.defineProperty(document, 'execCommand', inviteExecCommandDescriptor); else Reflect.deleteProperty(document, 'execCommand');
});

describe('Arena multiplayer production client/hook wiring', () => {
  it('disabled/unauthenticated 的真实 hook 不读取 auth、不发 fetch、不建 WSS', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);

    await act(async () => root.render(
      productionTree({ ...props, enabled: false }),
    ));
    await flush();
    expect(container.querySelector('[data-arena-multiplayer]')).toBeNull();

    await act(async () => root.render(
      productionTree({ ...props, isAuthenticated: false }),
    ));
    await flush();
    expect(container.textContent).toContain('多人房间需要登录后使用');
    expect(fetcher).not.toHaveBeenCalled();
    expect(authStorage.getAuthHeader).not.toHaveBeenCalled();
    expect(WiringSocket.instances).toHaveLength(0);
  });

  it('大厅对话框提供两种玩法提示、玩法说明链接与房间元信息', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/languages.json')) return Response.json([]);
      if (requestPath(url) === '/api/auth/verify') return Response.json({ success: false });
      if (requestPath(url) === '/api/arena/rooms/v1') {
        // 注意：目录页面响应与 RoomDirectoryPageSchema（strict）完全一致，无 protocolVersion。
        return Response.json({
          items: [{
            roomId: 'room-public-1',
            title: '欢迎加入',
            visibility: 'public',
            status: 'open',
            createdAt: '2026-09-04T00:00:00.000Z',
            lastActivityAt: new Date().toISOString(),
            hostDisplayName: 'Alice',
            memberCount: 3,
            memberLimit: 32,
          }],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected Room request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(productionTree(props)));
    await flush();
    await act(async () => button('打开多人房间').click());
    await flush();

    expect(document.body.textContent).toContain('两种最简单的玩法');
    expect(document.body.textContent).toContain('多人跑团');
    // 公开房间目录的丰富元信息（回归：只有标题和 UUID 的调试式列表）
    expect(document.body.textContent).toContain('欢迎加入');
    expect(document.body.textContent).toContain('Alice · 3/32 人');
    expect(document.body.textContent).toMatch(/前活跃|刚刚活跃/);
    const guideLink = [...document.body.querySelectorAll('a')]
      .find((candidate) => candidate.getAttribute('href') === '/encyclopedia/arena-multiplayer#两种最简单的玩法');
    expect(guideLink).not.toBeUndefined();
  });

  it.each(['host', 'member'] as const)(
    '%s 通过真实 client/hook 完成 join -> ticket -> WSS -> exit epoch fence',
    async (role) => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const session = sessionFor(role);
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/languages.json')) return Response.json([]);
        if (requestPath(url) === '/api/auth/verify') return Response.json({ success: false });
        if (requestPath(url) === '/api/arena/rooms/v1') {
          return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
        }
        if (url.endsWith('/join')) return Response.json(session);
        if (url.endsWith('/generations')) {
          return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
        }
        if (url.endsWith('/ticket')) {
          return Response.json({
            protocolVersion: 1,
            ticket: `ticket-${calls.length}`,
            expiresInSeconds: 45,
            websocket: {
              path: '/api/arena/rooms/v1/ws',
              protocol: 'mahoshojo.arena-room.v1',
            },
          });
        }
        if (url.endsWith('/leave') || url.endsWith('/close')) {
          return Response.json({
            protocolVersion: 1,
            roomId: 'room-1',
            outcome: url.endsWith('/close') ? 'closed' : 'left',
          });
        }
        throw new Error(`unexpected Room request: ${url}`);
      });
      vi.stubGlobal('fetch', fetcher);
      await act(async () => root.render(productionTree(props)));
      await enterJoinCode();
      await act(async () => button('加入房间').click());
      await flush();

      expect(WiringSocket.instances).toHaveLength(1);
      expect(WiringSocket.instances[0]).toMatchObject({
        url: 'ws://127.0.0.1:8787/api/arena/rooms/v1/ws?ticket=ticket-3',
        protocol: 'mahoshojo.arena-room.presence.v1',
        offeredProtocols: ['mahoshojo.arena-room.presence.v1', 'mahoshojo.arena-room.v1'],
      });
      await act(async () => WiringSocket.instances[0]!.open());
      const exitLabel = role === 'host' ? '关闭房间' : '离开房间';
      await act(async () => button('更多').click());
      await act(async () => button('房间成员与操作').click());
      await act(async () => button(exitLabel).click());
      await act(async () => button(role === 'host' ? '确认关闭房间' : '确认离开房间').click());
      await flush();

      const roomCalls = calls.filter((call) => requestPath(call.url).startsWith('/api/arena/rooms/v1'));
      expect(roomCalls.map((call) => requestPath(call.url))).toEqual([
        '/api/arena/rooms/v1',
        '/api/arena/rooms/v1/room-1/join',
        '/api/arena/rooms/v1/room-1/ticket',
        '/api/arena/rooms/v1/room-1/generations',
        `/api/arena/rooms/v1/room-1/${role === 'host' ? 'close' : 'leave'}`,
        // 会话以 ready 结束后自动回到大厅并刷新公开房间列表（回归：显示暂无公开房间）
        '/api/arena/rooms/v1',
      ]);
      expect(document.body.textContent).toContain('两种最简单的玩法');
      expect(document.body.textContent).toContain('两种最简单的玩法');
      expect(JSON.parse(String(roomCalls[4]?.init?.body))).toEqual({
        expectedRoomEpoch: 'epoch-1',
      });
      expect(new Headers(roomCalls[1]?.init?.headers).get('authorization'))
        .toBe('Bearer verified-key');
    },
  );

  it('复制邀请使用当前浏览站点 origin，不复用 Hono API origin', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/languages.json')) return Response.json([]);
        if (requestPath(url) === '/api/auth/verify') return Response.json({ success: false });
        if (requestPath(url) === '/api/arena/rooms/v1') {
          return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
        }
        if (url.endsWith('/join')) return Response.json(sessionFor('host'));
        if (url.endsWith('/ticket')) return Response.json({
          protocolVersion: 1,
          ticket: 'ticket-invite',
          expiresInSeconds: 45,
          websocket: {
            path: '/api/arena/rooms/v1/ws',
            protocol: 'mahoshojo.arena-room.v1',
          },
        });
        if (url.endsWith('/generations')) {
          return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
        }
        throw new Error(`unexpected Room request: ${url}`);
      });
      vi.stubGlobal('fetch', fetcher);
      await act(async () => root.render(productionTree(props)));
      await enterJoinCode();
      await act(async () => button('加入房间').click());
      await flush();
      await act(async () => WiringSocket.instances[0]!.open());

      await act(async () => button('分享房间').click());
      await flush();

      expect(writeText).toHaveBeenCalledTimes(1);
      const text = String(writeText.mock.calls[0]?.[0]);
      // 回归：props.origin 是 Hono API origin（此处 127.0.0.1:8787，生产为
      // homura.colanns.me），邀请链接必须指向用户正在浏览的 Web 站点。
      expect(text).toContain(`${window.location.origin}/arena`);
      expect(text).toContain('room-1');
      expect(text).toContain(`当前成员：1/${MAX_ROOM_MEMBERS} 人`);
      expect(text).not.toContain('当前在线');
      expect(text).not.toContain('127.0.0.1:8787');
    } finally {
      delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    }
  });

  const mountInviteRoom = async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/languages.json')) return Response.json([]);
      if (requestPath(url) === '/api/auth/verify') return Response.json({ success: false });
      if (requestPath(url) === '/api/arena/rooms/v1') return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
      if (url.endsWith('/join')) return Response.json(sessionFor('host'));
      if (url.endsWith('/ticket')) return Response.json({ protocolVersion: 1, ticket: 'ticket-invite', expiresInSeconds: 45,
        websocket: { path: '/api/arena/rooms/v1/ws', protocol: 'mahoshojo.arena-room.v1' } });
      if (url.endsWith('/generations')) return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
      throw new Error(`unexpected Room request: ${url}`);
    }));
    await act(async () => root.render(productionTree(props)));
    await enterJoinCode(); await act(async () => button('加入房间').click()); await flush();
    await act(async () => WiringSocket.instances.at(-1)!.open());
  };
  const rejoinInviteRoom = async () => {
    const controller = inviteController;
    const rendersBefore = renderedRoomIds.length;
    const observed: (string | null)[] = [];
    const retirement = createRoomInviteScope({ readScope: () => {
      const current = controller.getSnapshot().session;
      return current ? JSON.stringify([current.roomId, current.roomEpoch, current.self.userId]) : null;
    }, subscribe: controller.subscribe });
    const oldScope = retirement.getSnapshot(), stopRetirement = retirement.subscribe(() => {});
    const unsubscribe = controller.subscribe(() => observed.push(controller.getSnapshot().session?.roomId ?? null));
    await act(async () => controller.reset()); await flush();
    // The real view refreshes the directory after reset. Let that read settle before
    // an explicit rejoin; racing it would invalidate the join's operation generation.
    await enterJoinCode(); await act(async () => button('加入房间').click()); await flush();
    await act(async () => WiringSocket.instances.at(-1)!.open());
    unsubscribe(); stopRetirement();
    expect(inviteController).toBe(controller);
    expect(observed).toContain(null); expect(observed.at(-1)).toBe('room-1');
    expect(retirement.getSnapshot()).not.toBe(oldScope);
    expect(renderedRoomIds.slice(rendersBefore)).toContain(null);
  };

  it.each([true, false])('真实 controller 同实例重进同房后丢弃迟到复制结果 success=%s', async success => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const writeText = vi.fn(() => pending), readText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } });
    try {
      await mountInviteRoom(); expect(writeText).not.toHaveBeenCalled();
      await act(async () => button('分享房间').click());
      expect(button('复制房间邀请文案').textContent).toBe('复制中…');
      await rejoinInviteRoom();
      await act(async () => { if (success) resolve(); else reject(new Error('clipboard failed')); });
      expect(button('复制房间邀请文案').textContent).toBe('分享房间');
      expect(writeText).toHaveBeenCalledTimes(1); expect(readText).not.toHaveBeenCalled();
      expect(document.execCommand).not.toHaveBeenCalled();
    } finally { Reflect.deleteProperty(navigator, 'clipboard'); }
  });

  it('真实 controller 房间换代后旧 timer 不清除新邀请反馈', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    try {
      await mountInviteRoom(); vi.useFakeTimers();
      await act(async () => button('分享房间').click());
      await act(async () => vi.advanceTimersByTime(1_000));
      await rejoinInviteRoom(); expect(button('复制房间邀请文案').textContent).toBe('分享房间');
      await act(async () => button('分享房间').click());
      await act(async () => vi.advanceTimersByTime(1_000)); expect(button('复制房间邀请文案').textContent).toBe('已复制邀请');
      await act(async () => vi.advanceTimersByTime(1_000)); expect(button('复制房间邀请文案').textContent).toBe('分享房间');
    } finally { Reflect.deleteProperty(navigator, 'clipboard'); }
  });

  it.each([true, false])('账号退役后迟到复制 success=%s 不显示旧身份反馈', async success => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => pending) } });
    try {
      await mountInviteRoom(); await act(async () => button('分享房间').click());
      await act(async () => { beginAuthIdentityTransition(); });
      await act(async () => { if (success) resolve(); else reject(new Error('clipboard failed')); });
      expect(container.textContent).not.toContain('已复制邀请'); expect(container.textContent).not.toContain('复制失败，请重试');
    } finally { Reflect.deleteProperty(navigator, 'clipboard'); }
  });

  it('真实 hook 对 1013 取 fresh ticket，对 membership revoke 显示 replacement 并可 reset', async () => {
    vi.useFakeTimers();
    let ticketIndex = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (requestPath(url) === '/api/arena/rooms/v1') {
        return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
      }
      if (url.endsWith('/join')) return Response.json(sessionFor('member'));
      if (url.endsWith('/generations')) {
        return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
      }
      if (url.endsWith('/ticket')) {
        ticketIndex += 1;
        return Response.json({
          protocolVersion: 1,
          ticket: `ticket-${ticketIndex}`,
          expiresInSeconds: 45,
          websocket: {
            path: '/api/arena/rooms/v1/ws',
            protocol: 'mahoshojo.arena-room.v1',
          },
        });
      }
      throw new Error(`unexpected Room request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(productionTree(props)));
    await enterJoinCode();
    await act(async () => button('加入房间').click());
    await flush();
    await act(async () => WiringSocket.instances[0]!.open());

    await act(async () => WiringSocket.instances[0]!.closed(1013, 'authority-unavailable'));
    expect(container.textContent).toContain('正在重新连接');
    await act(async () => {
      // 默认重连延迟叠加 0.8–1.2× 乘性 jitter（基线 500ms），推进到上界 600ms
      // 才能对任意 RNG 结果确定性命中重连。
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(WiringSocket.instances).toHaveLength(2);
    expect(ticketIndex).toBe(2);

    await act(async () => WiringSocket.instances[1]!.open());
    await act(async () => WiringSocket.instances[1]!.closed(1008, 'membership-revoked'));
    expect(container.textContent).toContain('原房间无法恢复');
    await act(async () => button('返回房间大厅').click());
    expect(container.textContent).toContain('打开多人房间');
  });

  it('panelUi 桥接：runtime 外部入口可打开房主配置/提案 Modal（回归：底部大按钮共享状态）', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (requestPath(url) === '/api/arena/rooms/v1') {
        return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
      }
      if (url.endsWith('/join')) return Response.json(sessionFor('host'));
      if (url.endsWith('/generations')) {
        return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
      }
      if (url.endsWith('/ticket')) {
        return Response.json({
          protocolVersion: 1,
          ticket: 'ticket-1',
          expiresInSeconds: 45,
          websocket: {
            path: '/api/arena/rooms/v1/ws',
            protocol: 'mahoshojo.arena-room.v1',
          },
        });
      }
      throw new Error(`unexpected Room request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(
      <ArenaRoomProvider
        enabled={props.enabled}
        authenticated={props.isAuthenticated && !props.authLoading}
        origin={props.origin}
      >
        <QueryClientProvider client={queryClient}>
          <PanelUiProbe />
          <ArenaMultiplayerContextPanel {...props} />
        </QueryClientProvider>
      </ArenaRoomProvider>,
    ));
    await flush();
    await enterJoinCode();
    await act(async () => button('加入房间').click());
    await flush();

    expect(document.body.textContent).not.toContain('成员在主编辑区编辑，房主在此逐项审阅配置变更。');
    await act(async () => button('probe-open-proposals').click());
    await flush();
    expect(document.body.textContent).toContain('成员在主编辑区编辑，房主在此逐项审阅配置变更。');
    await act(async () => button('probe-open-config').click());
    await flush();
    expect(document.body.textContent).toContain('房间设置在主编辑区修改；此面板处理本地编辑与房间的同步。');
  });

  it('member 通过 production panel/client/WSS 提交并撤回，HTTP ack 不越权修改 snapshot', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const memberSession = sessionFor('member');
    const battleBefore = useBattleStore.getState();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/languages.json')) return Response.json([]);
      if (requestPath(url) === '/api/auth/verify') return Response.json({ success: false });
      if (requestPath(url) === '/api/arena/rooms/v1') {
        return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
      }
      if (url.endsWith('/join')) return Response.json(memberSession);
      if (url.endsWith('/ticket')) {
        return Response.json({
          protocolVersion: 1,
          ticket: `ticket-${calls.length}`,
          expiresInSeconds: 45,
          websocket: {
            path: '/api/arena/rooms/v1/ws',
            protocol: 'mahoshojo.arena-room.v1',
          },
        });
      }
      if (url.endsWith('/proposals')) {
        const intent = JSON.parse(String(init?.body)) as { proposalId: string };
        return Response.json({
          protocolVersion: 1,
          roomId: 'room-1',
          roomEpoch: 'epoch-1',
          controlSeq: 1,
          revision: 0,
          proposalId: intent.proposalId,
          status: 'submitted',
          result: 'applied',
        });
      }
      if (url.endsWith('/withdraw')) {
        const proposalId = decodeURIComponent(url.split('/proposals/')[1]!.split('/')[0]!);
        return Response.json({
          protocolVersion: 1,
          roomId: 'room-1',
          roomEpoch: 'epoch-1',
          controlSeq: 2,
          revision: 0,
          proposalId,
          status: 'withdrawn',
          result: 'applied',
        });
      }
      if (url.endsWith('/generations')) {
        return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
      }
      throw new Error(`unexpected Room request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(productionTree(props)));
    await enterJoinCode();
    await act(async () => button('加入房间').click());
    await flush();
    await act(async () => WiringSocket.instances[0]!.open());

    expect(container.textContent).toContain('竞技场提案编辑模式');
    expect(document.body.querySelector('#arena-room-proposals-dialog-heading')).toBeNull();
    await setTextField('arena-story-guidance', 'production 成员建议');
    await act(async () => button('预览提案').click());
    expect(document.body.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1);
    await act(async () => button('提交提案').click());
    await flush();

    const submitCall = calls.find((call) => requestPath(call.url).endsWith('/proposals'));
    if (!submitCall) throw new Error('submit call missing');
    const intent = JSON.parse(String(submitCall.init?.body)) as {
      proposalId: string;
      expectedRoomEpoch: string;
      baseRevision: number;
      changes: unknown[];
    };
    expect(intent).toMatchObject({
      expectedRoomEpoch: 'epoch-1',
      baseRevision: 0,
      changes: [{
        type: 'setUserGuidance',
        value: 'production 成员建议',
        expectedBase: { kind: 'value', value: '' },
      }],
    });
    expect(JSON.stringify(intent)).not.toMatch(/providerApiKey|userProviderConfig|credential/u);
    expect(container.textContent).not.toContain('我的待处理提案');
    expect(useBattleStore.getState()).toBe(battleBefore);

    const proposal = {
      proposalVersion: 1,
      proposalId: intent.proposalId,
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted',
      changes: intent.changes,
      createdAt: '2026-08-28T00:01:00.000Z',
    };
    await act(async () => WiringSocket.instances[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:01:00.000Z',
      type: 'proposal.submitted',
      payload: { proposal },
    })));
    expect(container.textContent).toContain('我的待处理提案');

    await act(async () => button('撤回提案').click());
    await flush();
    const withdrawCall = calls.find((call) => requestPath(call.url).endsWith('/withdraw'));
    expect(JSON.parse(String(withdrawCall?.init?.body))).toEqual({
      expectedRoomEpoch: 'epoch-1',
    });
    expect(container.textContent).toContain('我的待处理提案');

    await act(async () => WiringSocket.instances[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'proposal.resolved',
      payload: { proposalId: intent.proposalId, status: 'withdrawn' },
    })));
    expect(container.textContent).not.toContain(intent.proposalId);
  });

  it('host production Proposal 审阅携带 epoch/revision/selection fence，并等待 WSS resolve', async () => {
    const proposal = {
      proposalVersion: 1,
      proposalId: 'proposal-host-review',
      roomId: 'room-1',
      authorUserId: 'user-member',
      baseRevision: 0,
      status: 'submitted',
      changes: [{
        changeId: 'guidance-1',
        type: 'setUserGuidance',
        value: '成员建议',
        expectedBase: { kind: 'value', value: '' },
      }],
      createdAt: '2026-08-28T00:01:00.000Z',
    };
    const hostSession = sessionFor('host');
    hostSession.snapshot.members.push({
      userId: 'user-member',
      role: 'member',
      displayName: '成员',
      membershipState: 'active',
    });
    hostSession.snapshot.proposals.push(proposal);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (requestPath(url) === '/api/arena/rooms/v1') {
        return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
      }
      if (url.endsWith('/join')) return Response.json(hostSession);
      if (url.endsWith('/ticket')) return Response.json({
        protocolVersion: 1,
        ticket: 'ticket-host',
        expiresInSeconds: 45,
        websocket: {
          path: '/api/arena/rooms/v1/ws',
          protocol: 'mahoshojo.arena-room.v1',
        },
      });
      if (url.endsWith('/resolve')) return Response.json({
        protocolVersion: 1,
        roomId: 'room-1',
        roomEpoch: 'epoch-1',
        controlSeq: 2,
        revision: 1,
        proposalId: proposal.proposalId,
        status: 'accepted',
        result: 'applied',
      });
      if (url.endsWith('/generations')) {
        return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
      }
      throw new Error(`unexpected Room request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(productionTree(props)));
    await enterJoinCode();
    await act(async () => button('加入房间').click());
    await flush();
    await act(async () => WiringSocket.instances[0]!.open());

    await act(async () => button('提案').click());
    expect(document.body.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1);
    await act(async () => button('接受所选').click());
    await flush();
    const resolveCall = calls.find((call) => requestPath(call.url).endsWith('/resolve'));
    expect(JSON.parse(String(resolveCall?.init?.body))).toEqual({
      expectedRoomEpoch: 'epoch-1',
      expectedRevision: 0,
      resolution: 'accept-selected',
      selectedChangeIds: ['guidance-1'],
    });
    expect(document.body.textContent).toContain(proposal.proposalId);

    await act(async () => WiringSocket.instances[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 1,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'room.config.updated',
      payload: { revision: 1, sharedConfig: { ...sharedConfig, userGuidance: '成员建议' } },
    })));
    await act(async () => WiringSocket.instances[0]!.message(JSON.stringify({
      protocolVersion: 1,
      roomId: 'room-1',
      roomEpoch: 'epoch-1',
      controlSeq: 2,
      timestamp: '2026-08-28T00:02:00.000Z',
      type: 'proposal.resolved',
      payload: { proposalId: proposal.proposalId, status: 'accepted' },
    })));
    expect(document.body.textContent).not.toContain(proposal.proposalId);
  });

  it.each(['absent', 'matching-terminal'] as const)('malformed Proposal 2xx 只发一次；%s 对账仅在完整身份匹配终态时解锁', async (evidence) => {
    const memberSession = sessionFor('member');
    let proposalCalls = 0;
    let ticketIndex = 0;
    let submittedRequest: ArenaRoomProposalSubmitRequest | null = null;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/languages.json')) return Response.json([]);
      if (requestPath(url) === '/api/auth/verify') return Response.json({ success: false });
      if (requestPath(url) === '/api/arena/rooms/v1') {
        return Response.json({ protocolVersion: 1, items: [], nextCursor: null });
      }
      if (url.endsWith('/join')) return Response.json(memberSession);
      if (url.endsWith('/ticket')) {
        ticketIndex += 1;
        return Response.json({
          protocolVersion: 1,
          ticket: `ticket-${ticketIndex}`,
          expiresInSeconds: 45,
          websocket: {
            path: '/api/arena/rooms/v1/ws',
            protocol: 'mahoshojo.arena-room.v1',
          },
        });
      }
      if (url.endsWith('/proposals')) {
        proposalCalls += 1;
        submittedRequest = JSON.parse(String(init?.body)) as ArenaRoomProposalSubmitRequest;
        return Response.json({ ok: true, malformed: true });
      }
      if (url.endsWith('/session')) {
        const confirmed = evidence === 'matching-terminal' ? submittedRequest : null;
        return Response.json({
          ...memberSession,
          snapshot: { ...memberSession.snapshot, controlSeq: 1,
            ...(confirmed ? { revision: 1, sharedConfig: { ...sharedConfig, userGuidance: 'unknown 对账建议' } } : {}),
            proposals: confirmed ? [{
              proposalVersion: 1,
              proposalId: confirmed.proposalId,
              roomId: memberSession.roomId,
              authorUserId: memberSession.self.userId,
              baseRevision: confirmed.baseRevision,
              changes: confirmed.changes,
              status: 'accepted',
              createdAt: '2026-08-28T00:01:00.000Z',
            }] : [],
          },
        });
      }
      if (url.endsWith('/generations')) {
        return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
      }
      throw new Error(`unexpected Room request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(productionTree(props)));
    await enterJoinCode();
    await act(async () => button('加入房间').click());
    await flush();
    await act(async () => WiringSocket.instances[0]!.open());
    expect(container.textContent).toContain('竞技场提案编辑模式');
    await setTextField('arena-story-guidance', 'unknown 对账建议');
    await act(async () => button('预览提案').click());
    await act(async () => button('提交提案').click());
    await flush();

    expect(proposalCalls).toBe(1);
    expect(container.textContent).toContain('上次提案请求结果未知');
    expect(button('预览提案').disabled).toBe(true);
    await act(async () => button('预览提案').click());
    await flush();
    expect(proposalCalls).toBe(1);

    await act(async () => button('重新连接并对账').click());
    await flush();
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/session'))).toBe(true);
    expect(ticketIndex).toBe(2);
    expect(WiringSocket.instances).toHaveLength(2);
    expect(proposalCalls).toBe(1);
    if (evidence === 'absent') {
      // A successful GET and an absent ID cannot confirm the dispatched POST outcome.
      expect(container.textContent).toContain('上次提案请求结果未知');
      expect(button('预览提案').disabled).toBe(true);
    } else {
      expect(container.textContent).not.toContain('上次提案请求结果未知');
      expect(container.textContent).toContain('提案已全量接受');
      expect(button('预览提案').disabled).toBe(false);
    }
  });
});

it.each(['mahoshojo.arena-room.presence.v1', 'mahoshojo.arena-room.v1', ''])(
  '共享成员视图保留 Web socket-open 语义，presence 仅在真实协商和匹配帧后可用：%s',
  async (protocol) => {
    const session = sessionFor('member');
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/languages.json')) return Response.json([]);
      if (requestPath(url) === '/api/auth/verify') return Response.json({ success: false });
      if (requestPath(url) === '/api/arena/rooms/v1') return Response.json({ items: [], nextCursor: null });
      if (url.endsWith('/join')) return Response.json(session);
      if (url.endsWith('/generations')) {
        return Response.json({ protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', items: [] });
      }
      if (url.endsWith('/ticket')) return Response.json({
        protocolVersion: 1, ticket: 'ticket-presence', expiresInSeconds: 45,
        websocket: { path: '/api/arena/rooms/v1/ws', protocol: 'mahoshojo.arena-room.v1' },
      });
      throw new Error(`unexpected Room request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(productionTree(props)));
    await enterJoinCode();
    await act(async () => button('加入房间').click());
    await flush();
    const socket = WiringSocket.instances[0]!;
    Object.defineProperty(socket, 'protocol', { value: protocol });
    await act(async () => socket.open());
    // Web 的既有 connected 表示 socket-open，不因本次抽取增加 session-attached 门槛。
    expect(container.textContent).toContain('房间已连接');
    await act(async () => button('更多').click());
    await act(async () => button('房间成员与操作').click());
    expect(document.body.querySelectorAll('[data-member-presence="unknown"]')).toHaveLength(2);
    expect(button('离开房间').disabled).toBe(false);

    const presence = {
      protocolVersion: 1, type: 'room.presence', roomId: 'room-1', roomEpoch: 'epoch-1', onlineUserIds: ['user-host'],
    };
    for (const mismatch of [{ roomId: 'another-room' }, { roomEpoch: 'old-epoch' }]) {
      await act(async () => socket.message(JSON.stringify({ ...presence, ...mismatch })));
      expect(document.body.querySelectorAll('[data-member-presence="unknown"]')).toHaveLength(2);
    }
    await act(async () => socket.message(JSON.stringify(presence)));
    if (protocol === 'mahoshojo.arena-room.presence.v1') {
      expect(document.body.querySelectorAll('[data-member-presence="online"]')).toHaveLength(1);
      expect(document.body.querySelectorAll('[data-member-presence="offline"]')).toHaveLength(1);
      expect(document.body.textContent).toContain('当前 2 位成员，1 人在线，1 人离线。');
    } else {
      expect(document.body.querySelectorAll('[data-member-presence="unknown"]')).toHaveLength(2);
      expect(document.body.textContent).toContain('在线状态暂不可用');
    }
    await act(async () => socket.closed(1006, 'connection-lost'));
    expect(document.body.querySelectorAll('[data-member-presence="unknown"]')).toHaveLength(2);
    expect(button('离开房间').disabled).toBe(true);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/join'))).toHaveLength(1);
  },
);
