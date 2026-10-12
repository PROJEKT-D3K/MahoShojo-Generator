// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import React, { act, useEffect, useLayoutEffect } from 'react';
import { ArenaRoomSharedConfigSchema } from '@mahoshojo/contracts/arena-room';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authApi, authStorage } from '@/lib/auth';
import { captureAuthIdentity } from '@/lib/auth-identity';
import {
  ensureAuthState,
  getAuthSnapshot,
  logoutAndSyncAuthState,
  resetAuthStoreForTests,
} from '@/lib/auth-client-store';
import { useAuth } from '@/lib/useAuth';
import {
  ArenaRoomProvider,
  useArenaRoomContext,
  type ArenaRoomRuntime,
} from '@/components/arena/multiplayer/useArenaRoom';

const AUTH_KEY = 'mahoshojo_auth';
const ORIGIN = 'https://room.example.test';
const accountA = { id: 101, username: 'fixture-a' };
const accountB = { id: 202, username: 'fixture-b' };
const fixtureKey = (id: number) => `synthetic-room-auth-${id}`;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const member = { userId: 'room-member-a', role: 'member', displayName: 'A', membershipState: 'active' };
const session = {
  protocolVersion: 1, roomId: 'room-a', roomEpoch: 'epoch-a', self: member,
  snapshot: {
    protocolVersion: 1, schemaVersion: 1, roomId: 'room-a', roomEpoch: 'epoch-a', revision: 0, controlSeq: 0,
    sharedConfig: {
      battleMode: 'daily', reportFormat: 'markdown', combatants: [], teams: [], scenario: null,
      auxScenarios: [], materials: [], userGuidance: '', storyLength: 'default', customStoryLength: null,
      selectedLanguage: 'zh-CN', historySettings: {
        readArenaHistory: true, readArenaHistoryLimit: 3, isArenaHistoryUnlimited: false, writeArenaHistory: true,
        readCurrentState: true, writeCurrentState: true, readNarrativeHistory: false, readNarrativeHistoryLimit: 10,
        isNarrativeHistoryUnlimited: false, writeNarrativeHistory: false,
      },
    },
    members: [{ userId: 'room-host', role: 'host', displayName: 'Host', membershipState: 'active' }, member,
      { userId: 'room-member-b', role: 'member', displayName: 'B', membershipState: 'active' }],
    proposals: [], activeGeneration: null,
  },
};
class ControlledSocket {
  static instances: ControlledSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn();
  readonly send = vi.fn();
  readonly protocol: string;
  constructor(_url: string, protocols: string | string[]) {
    this.protocol = Array.isArray(protocols) ? protocols[0]! : protocols;
    ControlledSocket.instances.push(this);
  }
}
let root: Root;
let container: HTMLDivElement;
let runtime: ArenaRoomRuntime;
let encryptedB: string;
let serverUser = accountA;
let delayedJoin: ReturnType<typeof deferred<Response>> | null;
let joinEntered: ReturnType<typeof deferred<void>>;
let ticketCalls: number;
let leaveActors: number[];
let probeMounts: number;
let probeUnmounts: number;

function Probe() {
  useEffect(() => { probeMounts += 1; return () => { probeUnmounts += 1; }; }, []);
  const value = useArenaRoomContext()!;
  useLayoutEffect(() => { runtime = value; }, [value]);
  return <output>{value.state.session?.roomId ?? 'no-room'}</output>;
}
function AuthBoundRoom() {
  const { isAuthenticated, loading } = useAuth();
  // Same account propagation as the current ArenaPage production adapter.
  return <ArenaRoomProvider enabled authenticated={isAuthenticated && !loading} origin={ORIGIN}>
    <Probe />
  </ArenaRoomProvider>;
}

const changeOtherTabToB = async () => {
  const oldValue = localStorage.getItem(AUTH_KEY);
  serverUser = accountB;
  await act(async () => {
    localStorage.setItem(AUTH_KEY, encryptedB);
    window.dispatchEvent(new StorageEvent('storage', {
      key: AUTH_KEY, oldValue, newValue: encryptedB, storageArea: window.localStorage,
      url: `${window.location.origin}/character-manager`,
    }));
  });
};

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('WebSocket', ControlledSocket);
  ControlledSocket.instances = [];
  serverUser = accountA;
  delayedJoin = null;
  joinEntered = deferred<void>();
  ticketCalls = 0;
  leaveActors = [];
  probeMounts = 0;
  probeUnmounts = 0;
  authStorage.clearAuth();
  resetAuthStoreForTests();
  // Prepare an actual encrypted storage value before subscribing this tab.
  await authStorage.setAuth({ username: accountB.username, userId: accountB.id, authKey: fixtureKey(accountB.id) });
  encryptedB = localStorage.getItem(AUTH_KEY)!;
  await authStorage.setAuth({ username: accountA.username, userId: accountA.id, authKey: fixtureKey(accountA.id) });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input), ORIGIN).pathname;
    if (path === '/api/auth/verify') return Response.json({ success: true, user: serverUser,
      authSource: 'better-auth-session', authKey: fixtureKey(serverUser.id), badges: [] });
    if (path === '/api/auth/sign-out') return Response.json({ success: true });
    if (path.endsWith('/join')) { joinEntered.resolve(); return delayedJoin ? delayedJoin.promise : Response.json(session); }
    if (path.endsWith('/leave')) {
      // Model the server correctly authorizing either actual member; never log the credential.
      const header = new Headers(init?.headers).get('authorization');
      const actor = [accountA, accountB].find((account) => header === `Bearer ${fixtureKey(account.id)}`);
      if (!actor) throw new Error('Missing synthetic member authorization');
      leaveActors.push(actor.id);
      return Response.json({ protocolVersion: 1, roomId: 'room-a', outcome: 'left' });
    }
    if (path.endsWith('/ticket')) {
      ticketCalls += 1;
      return Response.json({ protocolVersion: 1, ticket: 'synthetic-ticket', expiresInSeconds: 45,
        websocket: { path: '/api/arena/rooms/v1/ws', protocol: 'mahoshojo.arena-room.v1' } });
    }
    if (path.endsWith('/generations')) return Response.json({ protocolVersion: 1, roomId: 'room-a', roomEpoch: 'epoch-a', items: [] });
    throw new Error(`Unexpected synthetic request path: ${path}`);
  }));
  await ensureAuthState();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<AuthBoundRoom />));
});
afterEach(async () => {
  delayedJoin?.resolve(Response.json(session));
  await act(async () => root.unmount());
  container.remove();
  authStorage.clearAuth();
  resetAuthStoreForTests();
  vi.unstubAllGlobals();
});

describe('Room uses the shared Web account identity across tabs', () => {
  it('同标签页退出完成会撤销原连接，作为真实链路对照', async () => {
    await act(async () => { await runtime.controller.join('room-a', 'A'); });
    const socket = ControlledSocket.instances[0]!;
    await act(async () => socket.onopen?.());
    expect(runtime.state.session?.self.userId).toBe('room-member-a');
    await act(async () => { await logoutAndSyncAuthState(); });
    expect(getAuthSnapshot().user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(1000, 'client-disconnect');
    expect(runtime.state.session).toBeNull();
  });

  it('普通新页面 verify 只刷新活动 token 时，同账号已连接 Room 不退房', async () => {
    await act(async () => { await runtime.controller.join('room-a', 'A'); });
    const socket = ControlledSocket.instances[0]!;
    await act(async () => socket.onopen?.());
    const identity = captureAuthIdentity();
    const raw = localStorage.getItem(AUTH_KEY);
    const nonce = localStorage.getItem('mahoshojo_auth_change');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, user: accountA,
      authSource: 'better-auth-session', authKey: fixtureKey(accountA.id), activityToken: 'synthetic-new-page-activity', badges: [] }));
    await act(async () => { await authApi.verify(); });
    expect(captureAuthIdentity()).toBe(identity);
    expect(localStorage.getItem(AUTH_KEY)).toBe(raw);
    expect(localStorage.getItem('mahoshojo_auth_change')).toBe(nonce);
    expect(socket.close).not.toHaveBeenCalled();
    expect(runtime.state.phase).toBe('connected');
    expect(await authStorage.getActivityHeaders()).toMatchObject({ 'x-mahoshojo-activity-token': 'synthetic-new-page-activity' });
  });

  it('另一标签页切换身份后立即撤销原 Room socket 与 session', async () => {
    await act(async () => { await runtime.controller.join('room-a', 'A'); });
    const socket = ControlledSocket.instances[0]!;
    await act(async () => socket.onopen?.());
    await changeOtherTabToB();
    expect((await authStorage.getAuth())?.userId).toBe(accountB.id);
    expect.soft(getAuthSnapshot().user?.id).not.toBe(accountA.id);
    expect.soft(socket.close).toHaveBeenCalledWith(1000, 'client-disconnect');
    expect.soft(runtime.state.session).toBeNull();
  });

  it('A 和 B 都是同房成员时，旧 A 界面不得借 B 身份发送离开命令', async () => {
    await act(async () => { await runtime.controller.join('room-a', 'A'); });
    const oldController = runtime.controller;
    await changeOtherTabToB();
    await act(async () => { await oldController.leave(); });
    expect(leaveActors).toEqual([]);
  });

  it('身份切换同一调用栈内的旧 socket 回调不得回填房间配置', async () => {
    await act(async () => { await runtime.controller.join('room-a', 'A'); });
    const oldController = runtime.controller;
    const socket = ControlledSocket.instances[0]!;
    await act(async () => socket.onopen?.());
    const oldMessage = socket.onmessage!;
    await act(async () => {
      const oldValue = localStorage.getItem(AUTH_KEY);
      serverUser = accountB;
      localStorage.setItem(AUTH_KEY, encryptedB);
      window.dispatchEvent(new StorageEvent('storage', {
        key: AUTH_KEY, oldValue, newValue: encryptedB, storageArea: window.localStorage,
      }));
      oldMessage({ data: JSON.stringify({
        protocolVersion: 1, roomId: 'room-a', roomEpoch: 'epoch-a', controlSeq: 1,
        timestamp: '2026-10-01T00:00:00.000Z', type: 'room.config.updated',
        payload: { revision: 1, sharedConfig: { ...session.snapshot.sharedConfig, userGuidance: 'old A socket content' } },
      }) });
      expect(oldController.getSnapshot().session?.snapshot.sharedConfig.userGuidance).not.toBe('old A socket content');
    });
  });

  it('身份换代清 Room 编辑器/房主基线/Modal，旧回调失效且不重挂普通 Arena 子树', async () => {
    await act(async () => { await runtime.controller.join('room-a', 'A'); });
    const old = runtime;
    const editor = old.proposalWorkspace.editor!;
    expect(editor).not.toBeNull();
    const sharedConfig = ArenaRoomSharedConfigSchema.parse(session.snapshot.sharedConfig);
    const authority = { roomId: 'room-a', roomEpoch: 'epoch-a', revision: 0, ownerUserId: 'room-member-a', sharedConfig };
    old.hostWorkspace.capturePublished(authority, { sharedConfig, hostLocalPayloads: [], hostLocalContentDigests: [] });
    expect(old.hostWorkspace.settledAuthority()).not.toBeNull();
    await act(async () => { old.panelUi.setConfigOpen(true); old.panelUi.setProposalsOpen(true); });
    expect(runtime.panelUi).toMatchObject({ configOpen: true, proposalsOpen: true });
    await changeOtherTabToB();
    expect(editor.store.getState().disposed).toBe(true);
    expect(old.hostWorkspace.settledAuthority()).toBeNull();
    expect(runtime.proposalWorkspace.editor).toBeNull();
    expect(runtime.hostReconciliation.state).toEqual({ kind: 'idle' });
    expect(runtime.latestGenerationHistory).toMatchObject({ status: 'idle', latest: null, completedCount: 0 });
    expect(runtime.panelUi).toMatchObject({ configOpen: false, proposalsOpen: false });
    await act(async () => { old.panelUi.setConfigOpen(true); old.proposalWorkspace.syncFromRoom(); });
    expect(runtime.panelUi.configOpen).toBe(false);
    expect(runtime.proposalWorkspace.editor).toBeNull();
    expect(probeMounts).toBe(1);
    expect(probeUnmounts).toBe(0);
  });

  it('另一标签页切换身份后，原 A 的迟到 join 不申请 ticket 或建立旧 Room', async () => {
    delayedJoin = deferred<Response>();
    let joining!: Promise<void>;
    await act(async () => {
      joining = runtime.controller.join('room-a', 'A');
      await joinEntered.promise;
    });
    await changeOtherTabToB();
    await act(async () => { delayedJoin!.resolve(Response.json(session)); await joining; });
    expect.soft(ticketCalls).toBe(0);
    expect.soft(ControlledSocket.instances).toHaveLength(0);
    expect.soft(runtime.state.session).toBeNull();
  });
});
