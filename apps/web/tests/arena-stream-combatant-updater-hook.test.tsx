// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ownedHeaders: vi.fn(), buildPayload: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authStorage: { getOwnedAuthHeaders: mocks.ownedHeaders } }));
vi.mock('@mahoshojo/domain/arena-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mahoshojo/domain/arena-reconciliation')>();
  return { ...actual, buildArenaReconciliationRetryPayload: (...args: Parameters<typeof actual.buildArenaReconciliationRetryPayload>) => (
    mocks.buildPayload(...args) ?? actual.buildArenaReconciliationRetryPayload(...args)
  ) };
});
import { useStreamCombatantUpdater } from '@/components/arena/hooks/useStreamCombatantUpdater';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { AUTH_STORAGE_KEY, captureAuthIdentity, type AuthIdentity } from '@/lib/auth-identity';
import { ARENA_GENERATION_ACTOR_TOKEN_HEADER, ARENA_GENERATION_ACTOR_TOKEN_KEY } from '@/lib/arena/resumable-generation-client';

let currentHook: ReturnType<typeof useStreamCombatantUpdater> | null = null;

const Harness = () => {
  const hook = useStreamCombatantUpdater();
  useEffect(() => { currentHook = hook; }, [hook]);
  return null;
};

beforeEach(() => {
  mocks.ownedHeaders.mockReset().mockImplementation(async (identity: AuthIdentity) => ({ identity, headers: {} }));
  mocks.buildPayload.mockReset();
  localStorage.clear();
});

afterEach(() => {
  currentHook = null;
  vi.unstubAllGlobals();
  useBattleStore.setState({
    combatants: [],
    updatedCombatants: [],
    lastGenerationId: null,
  });
});

describe('useStreamCombatantUpdater', () => {
  it('有 generationId 时不再用本地 Markdown 解析阻断权威对账', async () => {
    const combatant = {
      type: 'general-character' as const,
      filename: '角色-a.json',
      isValid: false,
      isPreset: false,
      data: { name: '角色 A' },
    };
    useBattleStore.setState({ combatants: [combatant], updatedCombatants: [] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      updatedCombatants: [],
      warnings: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    if (!currentHook) throw new Error('updater hook 未挂载');

    await act(async () => currentHook!.updateFromMarkdown('', [combatant], 'classic', {
      userGuidance: '客户端不再上传',
      writeArenaHistory: true,
      writeCurrentState: false,
    }, null, undefined, 'generation-authoritative-001'));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      generationId: 'generation-authoritative-001',
      combatants: [{
        type: 'general-character',
        data: { name: '角色 A' },
        isPreset: false,
        filename: '角色-a.json',
      }],
    });

    await act(async () => root.unmount());
    container.remove();
  });

  it('调用方上下文已失效时不提交也不写入 roster', async () => {
    const originalCombatant = {
      type: 'general-character' as const,
      filename: '角色-a.json',
      isValid: false,
      isPreset: false,
      data: { name: '角色 A', marker: 'original' },
    };
    useBattleStore.setState({
      combatants: [originalCombatant],
      updatedCombatants: [],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      updatedCombatants: [{ name: '角色 A', marker: 'stale-server-result' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    if (!currentHook) throw new Error('updater hook 未挂载');

    await act(async () => {
      await expect(currentHook!.updateCombatants({
        combatants: [{
          type: originalCombatant.type,
          data: originalCombatant.data,
          isNative: false,
          isPreset: false,
        }],
      }, {
        canCommit: () => false,
      })).rejects.toThrow('角色更新上下文已变化');
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(useBattleStore.getState().combatants).toEqual([originalCombatant]);
    expect(useBattleStore.getState().updatedCombatants).toEqual([]);

    await act(async () => root.unmount());
    container.remove();
  });

  it('重复角色名只按服务端返回的 combatantIndex 合并', async () => {
    const combatants = [
      {
        type: 'general-character' as const,
        filename: 'a.json',
        isValid: false,
        isPreset: false,
        data: { name: '同名角色', marker: 'first' },
      },
      {
        type: 'general-character' as const,
        filename: 'b.json',
        isValid: true,
        isPreset: false,
        data: { name: '同名角色', marker: 'second' },
      },
    ];
    useBattleStore.setState({ combatants, updatedCombatants: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      updatedCombatants: [{
        combatantIndex: 1,
        data: { name: '同名角色', marker: 'updated-second' },
        isNative: false,
      }],
      warnings: [{
        combatantIndex: 0,
        code: 'ARENA_RECONCILIATION_COMBATANT_UNMATCHED',
        message: '第一张角色未匹配，已跳过。',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    if (!currentHook) throw new Error('updater hook 未挂载');

    await act(async () => currentHook!.updateCombatants({
      generationId: 'generation-duplicate-name',
      combatants: combatants.map((combatant) => ({
        type: combatant.type,
        data: combatant.data,
        isNative: false,
        isPreset: false,
        filename: combatant.filename,
      })),
    }));

    expect(useBattleStore.getState().combatants.map((item) => (
      'data' in item ? item.data.marker : null
    ))).toEqual(['first', 'updated-second']);
    expect((useBattleStore.getState().combatants[1] as { isValid?: boolean }).isValid).toBe(false);
    expect(useBattleStore.getState().updatedCombatants).toEqual([
      { name: '同名角色', marker: 'updated-second' },
    ]);
    expect(currentHook.updateError).toContain('第一张角色未匹配');

    await act(async () => root.unmount());
    container.remove();
  });

  it('combatantIndex 以提交的可读角色数组为坐标，不受随机占位符偏移', async () => {
    const placeholder = {
      type: 'random-magical-girl' as const,
      id: 'random-slot-1',
      filename: 'random-slot-1',
    };
    const first = {
      type: 'general-character' as const,
      filename: 'a.json',
      isValid: false,
      isPreset: false,
      data: { name: '角色 A', marker: 'first' },
    };
    const second = {
      type: 'general-character' as const,
      filename: 'b.json',
      isValid: true,
      isPreset: false,
      data: { name: '角色 B', marker: 'second' },
    };
    useBattleStore.setState({ combatants: [placeholder, first, second], updatedCombatants: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      updatedCombatants: [{
        combatantIndex: 1,
        data: { name: '角色 B', marker: 'updated-second' },
        isNative: false,
      }],
      warnings: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    if (!currentHook) throw new Error('updater hook 未挂载');

    await act(async () => currentHook!.updateCombatants({
      generationId: 'generation-placeholder-index',
      combatants: [first, second],
    }));

    const roster = useBattleStore.getState().combatants;
    expect(roster[0]).toEqual(placeholder);
    expect('data' in roster[1]! ? roster[1].data.marker : null).toBe('first');
    expect('data' in roster[2]! ? roster[2].data.marker : null).toBe('updated-second');
    expect('data' in roster[2]! ? roster[2].isValid : null).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  it('响应到达前 roster 被替换时不按旧 index 覆盖新卡', async () => {
    const originalCombatant = {
      type: 'general-character' as const,
      filename: 'a.json',
      isValid: false,
      isPreset: false,
      data: { name: '角色 A', marker: 'original' },
    };
    const replacement = {
      ...originalCombatant,
      filename: 'replacement.json',
      data: { name: '角色 B', marker: 'replacement' },
    };
    useBattleStore.setState({ combatants: [originalCombatant], updatedCombatants: [] });
    let resolveResponse!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    })));

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    if (!currentHook) throw new Error('updater hook 未挂载');

    await act(async () => {
      const pending = currentHook!.updateCombatants({
        generationId: 'generation-race-001',
        combatants: [{
          type: originalCombatant.type,
          data: originalCombatant.data,
          isPreset: false,
          filename: originalCombatant.filename,
        }],
      });
      await vi.waitFor(() => expect(resolveResponse).toBeTypeOf('function'));
      useBattleStore.setState({ combatants: [replacement] });
      resolveResponse(new Response(JSON.stringify({
        success: true,
        updatedCombatants: [{
          combatantIndex: 0,
          data: { name: '角色 A', marker: 'stale-result' },
          isNative: false,
        }],
        warnings: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      await expect(pending).rejects.toThrow('角色更新上下文已变化');
    });
    expect(useBattleStore.getState().combatants).toEqual([replacement]);

    await act(async () => root.unmount());
    container.remove();
  });

  it('重试上传重排后的当前卡片，按本次请求 index 接受服务器的局部对账结果', async () => {
    const first = {
      type: 'general-character' as const, filename: 'first.json', isPreset: false, isValid: false,
      data: { name: '同名角色', marker: 'first' },
    };
    const second = { ...first, filename: 'second.json', data: { name: '同名角色', marker: 'second' } };
    const generationId = 'generation-reordered-current';
    const roster = [second, first];
    const updatedData = {
      name: '同名角色', marker: 'second-updated', signature: 'server-signature',
      current_state: { generation_id: generationId, summary: '服务器冻结结果' },
    };
    useBattleStore.setState({ combatants: roster, updatedCombatants: [] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      updatedCombatants: [{ combatantIndex: 0, data: updatedData, isNative: true }],
      warnings: [{ code: 'ARENA_RECONCILIATION_ROSTER_COMBATANT_MISSING', message: '缺失角色已跳过' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    try {
      await act(async () => currentHook!.retryGenerationUpdate(generationId, roster));
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
        generationId,
        combatants: [second, first].map(({ type, filename, data, isPreset }) => ({ type, filename, data, isPreset })),
      });
      expect(useBattleStore.getState().combatants).toEqual([{ ...second, data: updatedData, isValid: true }, first]);
      expect(useBattleStore.getState().updatedCombatants).toEqual([updatedData]);
      expect(currentHook!.updateError).toContain('缺失角色已跳过');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(['reorder', 'remove', 'generation', 'current-state'] as const)(
    '请求发出后的 %s 变化使迟到响应失效，已有结果不被覆盖', async (change) => {
      const first = {
        type: 'general-character' as const, filename: 'first.json', isPreset: false, isValid: false,
        data: { name: '同名角色', marker: 'first' },
      };
      const second = { ...first, filename: 'second.json', data: { name: '同名角色', marker: 'second' } };
      const generationId = 'generation-original';
      const previousUpdates = [{ name: '既有结果', arena_history: {} }];
      useBattleStore.setState({ combatants: [first, second], updatedCombatants: previousUpdates, lastGenerationId: generationId });
      let resolveResponse!: (response: Response) => void;
      const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve; }));
      vi.stubGlobal('fetch', fetchMock);
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(async () => root.render(<Harness />));
      try {
        await act(async () => {
          const pending = currentHook!.retryGenerationUpdate(generationId, [first, second], () => (
            useBattleStore.getState().lastGenerationId === generationId
          ));
          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
          if (change === 'reorder') useBattleStore.setState({ combatants: [second, first] });
          if (change === 'remove') useBattleStore.setState({ combatants: [first] });
          if (change === 'generation') useBattleStore.setState({ lastGenerationId: 'generation-new' });
          if (change === 'current-state') useBattleStore.setState({ combatants: [{
            ...first, data: { ...first.data, current_state: { generation_id: 'generation-new' } },
          }, second] });
          const currentRoster = useBattleStore.getState().combatants;
          resolveResponse(new Response(JSON.stringify({
            updatedCombatants: [{ combatantIndex: 0, data: { name: '过期结果' }, isNative: true }],
          }), { status: 200 }));
          await expect(pending).rejects.toThrow('角色更新上下文已变化');
          expect(useBattleStore.getState().combatants).toBe(currentRoster);
          expect(useBattleStore.getState().updatedCombatants).toBe(previousUpdates);
        });
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};
const ownerCombatant = {
  type: 'general-character' as const, filename: 'owner.json', isValid: false, isPreset: false,
  data: { name: '角色 A', marker: 'original' },
};
const mountUpdater = async () => {
  useBattleStore.setState({ combatants: [ownerCombatant], updatedCombatants: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  return async () => { await act(async () => root.unmount()); container.remove(); };
};
const successResponse = (marker: string) => new Response(JSON.stringify({
  updatedCombatants: [{ combatantIndex: 0, data: { name: '角色 A', marker }, isNative: false }],
}), { status: 200 });

describe('reconciliation invocation and auth ownership', () => {
  it.each(['stored bearer', 'cookie bootstrap', 'owned snapshot'] as const)('%s sends one identity snapshot with the real actor credential', async (source) => {
    vi.stubGlobal('crypto', webcrypto);
    const { authStorage } = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
    authStorage.clearAuth();
    const owner = { username: 'fixture-owner', userId: 101, authKey: 'synthetic-owner', activityToken: 'synthetic-activity' };
    if (source !== 'cookie bootstrap') await authStorage.setAuth(owner);
    const auth = source === 'owned snapshot' ? await authStorage.getOwnedAuthHeaders() : undefined;
    const readAuth = vi.spyOn(authStorage, 'getAuth');
    mocks.ownedHeaders.mockImplementation((identity: AuthIdentity) => authStorage.getOwnedAuthHeaders(identity));
    localStorage.setItem(ARENA_GENERATION_ACTOR_TOKEN_KEY, 'signed.fixture-actor');
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url === '/api/auth/verify'
      ? Response.json({ success: true, authSource: 'better-auth-session', authKey: owner.authKey,
        user: { id: owner.userId, username: owner.username }, activityToken: owner.activityToken })
      : successResponse('owner'));
    vi.stubGlobal('fetch', fetchMock);
    const cleanup = await mountUpdater();
    try {
      await act(async () => currentHook!.updateFromMarkdown('', [ownerCombatant], 'daily', {
        userGuidance: '', writeArenaHistory: true, writeCurrentState: false,
      }, null, undefined, 'generation-owner', { auth }));
      const updates = fetchMock.mock.calls.filter(([url]) => url === '/api/arena/update-combatants-after-stream');
      expect(updates).toHaveLength(1);
      expect(updates[0]![1]?.method).toBe('POST');
      expect(Object.fromEntries(new Headers(updates[0]![1]?.headers))).toEqual({
        authorization: 'Bearer synthetic-owner',
        'content-type': 'application/json',
        'x-mahoshojo-activity-token': 'synthetic-activity',
        'x-mahoshojo-user-id': '101',
        [ARENA_GENERATION_ACTOR_TOKEN_HEADER.toLowerCase()]: 'signed.fixture-actor',
      });
      expect(readAuth).toHaveBeenCalledTimes(source === 'owned snapshot' ? 0 : 1);
      expect(mocks.ownedHeaders).toHaveBeenCalledTimes(source === 'owned snapshot' ? 0 : 1);
      expect(fetchMock).toHaveBeenCalledTimes(source === 'cookie bootstrap' ? 2 : 1);
      expect(useBattleStore.getState().combatants[0]).toMatchObject({ data: { marker: 'owner' } });
    } finally {
      readAuth.mockRestore();
      authStorage.clearAuth();
      await cleanup();
    }
  });

  it.each(['success', 'error'] as const)('A 的迟到 %s 不清除 B busy、不写入 error/roster，且释放旧 body', async (kind) => {
    const cleanup = await mountUpdater();
    const responseA = deferred<Response>(), responseB = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(responseA.promise).mockReturnValueOnce(responseB.promise);
    vi.stubGlobal('fetch', fetchMock);
    let pendingA!: Promise<unknown>, pendingB!: Promise<unknown>;
    try {
      await act(async () => {
        pendingA = currentHook!.updateCombatants({ combatants: [ownerCombatant] }).catch(error => error);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      });
      await act(async () => {
        pendingB = currentHook!.updateCombatants({ combatants: [ownerCombatant] });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      });
      const staleResponse = kind === 'success'
        ? successResponse('stale-A') : new Response(JSON.stringify({ error: '迟到的 A 错误' }), { status: 500 });
      const cancel = vi.spyOn(staleResponse.body!, 'cancel');
      await act(async () => { responseA.resolve(staleResponse); await pendingA; });
      expect(cancel).toHaveBeenCalledOnce();
      expect(currentHook!.isUpdating).toBe(true); expect(currentHook!.updateError).toBeNull();
      expect(useBattleStore.getState().combatants).toEqual([ownerCombatant]);
      await act(async () => { responseB.resolve(successResponse('current-B')); await pendingB; });
      expect(currentHook!.isUpdating).toBe(false); expect(currentHook!.updateError).toBeNull();
      expect(useBattleStore.getState().combatants[0]).toMatchObject({ data: { marker: 'current-B' } });
    } finally { await cleanup(); }
  });

  it('B 已完成后 A 的网络失败不覆盖 B 的 error 和 roster', async () => {
    const cleanup = await mountUpdater();
    const responseA = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(responseA.promise).mockResolvedValueOnce(successResponse('current-B'));
    vi.stubGlobal('fetch', fetchMock);
    let pendingA!: Promise<unknown>;
    try {
      await act(async () => {
        pendingA = currentHook!.updateCombatants({ combatants: [ownerCombatant] }).catch(error => error);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      });
      await act(async () => currentHook!.updateCombatants({ combatants: [ownerCombatant] }));
      await act(async () => { responseA.reject(new Error('A network failure')); await pendingA; });
      expect(currentHook!.isUpdating).toBe(false); expect(currentHook!.updateError).toBeNull();
      expect(useBattleStore.getState().combatants[0]).toMatchObject({ data: { marker: 'current-B' } });
    } finally { await cleanup(); }
  });

  it.each(['headers', 'payload'] as const)('%s await 期间换号时 POST 零提交且 loading 解锁', async (phase) => {
    const cleanup = await mountUpdater();
    const identity = captureAuthIdentity();
    const headers = deferred<{ identity: AuthIdentity; headers: Record<string, string> }>();
    const payload = deferred<{ generationId: string; combatants: typeof ownerCombatant[] }>();
    if (phase === 'headers') mocks.ownedHeaders.mockReturnValueOnce(headers.promise);
    else mocks.buildPayload.mockReturnValueOnce(payload.promise);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    let pending!: Promise<unknown>;
    try {
      await act(async () => {
        pending = currentHook!.updateFromMarkdown('', [ownerCombatant], 'daily', {
          userGuidance: '', writeArenaHistory: true, writeCurrentState: false,
        }, null, undefined, 'generation-A').catch(error => error);
        await vi.waitFor(() => expect(phase === 'headers' ? mocks.ownedHeaders : mocks.buildPayload).toHaveBeenCalledOnce());
      });
      localStorage.setItem(AUTH_STORAGE_KEY, 'another-account');
      await act(async () => {
        if (phase === 'headers') headers.resolve({ identity, headers: { Authorization: 'Bearer frozen-A' } });
        else payload.resolve({ generationId: 'generation-A', combatants: [ownerCombatant] });
        expect(await pending).toBeInstanceOf(Error);
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(currentHook!.isUpdating).toBe(false); expect(currentHook!.updateError).toBeNull();
      expect(useBattleStore.getState().combatants).toEqual([ownerCombatant]);
    } finally { await cleanup(); }
  });

  it('updateFromMarkdown 在构建 payload 前拥有 token，旧 A 不会因晚完成准备而取代 B', async () => {
    const cleanup = await mountUpdater();
    const payloadA = deferred<{ generationId: string; combatants: typeof ownerCombatant[] }>();
    mocks.buildPayload.mockReturnValueOnce(payloadA.promise);
    const fetchMock = vi.fn().mockResolvedValueOnce(successResponse('current-B')); vi.stubGlobal('fetch', fetchMock);
    const settings = { userGuidance: '', writeArenaHistory: true, writeCurrentState: false };
    let pendingA!: Promise<unknown>;
    try {
      await act(async () => {
        pendingA = currentHook!.updateFromMarkdown('', [ownerCombatant], 'daily', settings, null, undefined, 'generation-A').catch(error => error);
        await vi.waitFor(() => expect(mocks.buildPayload).toHaveBeenCalledOnce());
      });
      await act(async () => currentHook!.updateFromMarkdown('', [ownerCombatant], 'daily', settings, null, undefined, 'generation-B'));
      await act(async () => {
        payloadA.resolve({ generationId: 'generation-A', combatants: [ownerCombatant] });
        expect(await pendingA).toBeInstanceOf(Error);
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).generationId).toBe('generation-B');
      expect(currentHook!.isUpdating).toBe(false); expect(currentHook!.updateError).toBeNull();
      expect(useBattleStore.getState().combatants[0]).toMatchObject({ data: { marker: 'current-B' } });
    } finally { await cleanup(); }
  });

  it('传入冻结 auth 时不重新读取账号，canCommit 失效后不提交', async () => {
    const cleanup = await mountUpdater();
    const identity = captureAuthIdentity();
    const auth = { identity, headers: { Authorization: 'Bearer frozen-owner', 'X-Activity-Token': 'frozen-activity' } };
    const fetchMock = vi.fn().mockResolvedValueOnce(successResponse('owner')); vi.stubGlobal('fetch', fetchMock);
    const settings = { userGuidance: '', writeArenaHistory: true, writeCurrentState: false };
    try {
      await act(async () => currentHook!.updateFromMarkdown('', [ownerCombatant], 'daily', settings, null, undefined, 'generation-owner', { auth, canCommit: () => true }));
      expect(mocks.ownedHeaders).not.toHaveBeenCalled();
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer frozen-owner');
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('X-Activity-Token')).toBe('frozen-activity');
      await act(async () => {
        await expect(currentHook!.updateFromMarkdown('', [ownerCombatant], 'daily', settings, null, undefined, 'generation-stale', { auth, canCommit: () => false })).rejects.toThrow('角色更新上下文已变化');
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { await cleanup(); }
  });
});
