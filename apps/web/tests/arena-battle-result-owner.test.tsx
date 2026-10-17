// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(), ownedHeaders: vi.fn(), openStream: vi.fn(), quickCheck: vi.fn(), cooldown: vi.fn(),
  update: vi.fn(), retryUpdate: vi.fn(), push: vi.fn(), backup: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ setQueryData: vi.fn() }) }));
vi.mock('@/lib/client-route-adapter', () => ({ useClientRouteAdapter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, startCooldown: mocks.cooldown, remainingTime: 0, otherRemainingTime: 0 }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.quickCheck }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: (text: string) => ({ filteredText: text }) }));
vi.mock('@/lib/arrested-backup', () => ({ persistArrestedBackup: mocks.backup }));
vi.mock('@/lib/auth', () => ({ authStorage: { getOwnedAuthHeaders: mocks.ownedHeaders }, AuthIdentityChangedError: class extends Error {} }));
vi.mock('@/lib/arena/narrative-draft-owner', () => ({ captureNarrativeDraftOwner: () => ({ scope: 'anonymous', isCurrent: () => true }) }));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleResolveRandomPlaceholders: async () => {} }) }));
vi.mock('@/components/arena/hooks/useStreamCombatantUpdater', () => ({ useStreamCombatantUpdater: () => ({ updateFromMarkdown: mocks.update, retryGenerationUpdate: mocks.retryUpdate }) }));
vi.mock('@/components/arena/multiplayer/useArenaRoom', () => ({ useArenaRoomContext: () => null }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/arena/resumable-generation-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/arena/resumable-generation-client')>(),
  openArenaGenerationStream: mocks.openStream,
}));

import { useBattleEngine } from '@/components/arena/hooks/useBattleEngine';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';
import { AUTH_STORAGE_KEY, beginAuthIdentityTransition, type AuthIdentity } from '@/lib/auth-identity';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};
const safeCheck = (text: string) => ({ hasSensitiveWords: false, matchDetails: [], detectedWords: [], filteredText: text });
const report = (owner: string) => ({
  headline: `${owner} 战报`, article: { body: `${owner} 正文`, analysis: '' },
  officialReport: { winner: '角色甲', conclusion: '' }, reporterInfo: { name: '记者', publication: 'Arena' },
});
const response = (owner: string) => new Response(JSON.stringify({
  report: report(owner), generationId: `generation-${owner}`,
  updatedCombatants: [{ name: '角色甲', marker: owner }],
}), { headers: { 'Content-Type': 'application/json' } });
const sse = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
let current: ReturnType<typeof useBattleEngine>, root: Root, container: HTMLDivElement;
const Harness = () => { const engine = useBattleEngine(); useEffect(() => { current = engine; }); return null; };

beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.quickCheck.mockImplementation(async (text: string) => safeCheck(text));
  mocks.update.mockResolvedValue(undefined);
  mocks.retryUpdate.mockResolvedValue(undefined);
  mocks.ownedHeaders.mockImplementation(async (identity: AuthIdentity) => ({ identity, headers: {} }));
  const initial = useBattleStore.getInitialState();
  useBattleStore.setState({ ...initial, reportFormat: 'markdown', generationMode: 'non-stream', battleMode: 'daily',
    combatants: [{ type: 'general-character', filename: 'test.json', data: { name: '角色甲' }, isValid: false, isPreset: false }],
    settings: { ...initial.settings, writeArenaHistory: true, writeCurrentState: false, writeNarrativeHistory: true },
  });
  useNarrativeHistoryStore.setState(useNarrativeHistoryStore.getInitialState());
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const holdOutputCheck = (owner: string, gate: ReturnType<typeof deferred<void>>) => {
  mocks.quickCheck.mockImplementation(async (text: string) => {
    if (text.startsWith('{') && text.includes(`"headline":"${owner} 战报"`)) await gate.promise;
    return safeCheck(text);
  });
};
const waitForOutputCheck = (owner: string) => vi.waitFor(() => expect(mocks.quickCheck.mock.calls.some(([text]) => (
  text.startsWith('{') && text.includes(`"headline":"${owner} 战报"`)
))).toBe(true));

describe('battle result ownership across asynchronous result work', () => {
  it('A 输出检查迟到不能覆盖已完成的 B 战报、角色、导航或叙事历史', async () => {
    const gate = deferred<void>(); holdOutputCheck('A', gate);
    mocks.dispatch.mockResolvedValueOnce(response('A')).mockResolvedValueOnce(response('B'));
    let pendingA!: Promise<void>;
    await act(async () => { pendingA = current.handleGenerate(); await waitForOutputCheck('A'); });
    await act(async () => current.handleGenerate());
    const stateB = useBattleStore.getState();
    await act(async () => { gate.resolve(); await pendingA; });
    expect(useBattleStore.getState()).toMatchObject({ newsReport: report('B'), isGenerating: false, error: null });
    expect(useBattleStore.getState().combatants).toBe(stateB.combatants);
    expect(useBattleStore.getState().resultNavigation).toBe(stateB.resultNavigation);
    expect(useBattleStore.getState().lastGenerationRepairContext).toEqual(stateB.lastGenerationRepairContext);
    expect(useNarrativeHistoryStore.getState().entries.map(entry => entry.id)).toEqual(['arena-generation:generation-B']);
    expect(mocks.cooldown).toHaveBeenCalledOnce();
  });

  it('A 的 finally 不能关闭仍在等待输出检查的 B loading', async () => {
    const gateA = deferred<void>(), gateB = deferred<void>();
    mocks.quickCheck.mockImplementation(async (text: string) => {
      if (text.startsWith('{') && text.includes('"headline":"A 战报"')) await gateA.promise;
      if (text.startsWith('{') && text.includes('"headline":"B 战报"')) await gateB.promise;
      return safeCheck(text);
    });
    mocks.dispatch.mockResolvedValueOnce(response('A')).mockResolvedValueOnce(response('B'));
    let pendingA!: Promise<void>, pendingB!: Promise<void>;
    await act(async () => { pendingA = current.handleGenerate(); await waitForOutputCheck('A'); });
    await act(async () => { pendingB = current.handleGenerate(); await waitForOutputCheck('B'); });
    await act(async () => { gateA.resolve(); await pendingA; });
    expect(useBattleStore.getState()).toMatchObject({ isGenerating: true, newsReport: null, error: null });
    await act(async () => { gateB.resolve(); await pendingB; });
    expect(useBattleStore.getState()).toMatchObject({ isGenerating: false, newsReport: report('B') });
  });

  it('换号但没有新请求时丢弃旧结果，同时释放 loading', async () => {
    const gate = deferred<void>(); holdOutputCheck('A', gate);
    mocks.dispatch.mockResolvedValueOnce(response('A'));
    const roster = useBattleStore.getState().combatants;
    let pending!: Promise<void>;
    await act(async () => { pending = current.handleGenerate(); await waitForOutputCheck('A'); });
    localStorage.setItem(AUTH_STORAGE_KEY, 'changed-account');
    await act(async () => { gate.resolve(); await pending; });
    expect(useBattleStore.getState()).toMatchObject({ isGenerating: false, newsReport: null, resultNavigation: null, error: null });
    expect(useBattleStore.getState().combatants).toBe(roster);
    expect(useNarrativeHistoryStore.getState().entries).toEqual([]);
    expect(mocks.cooldown).not.toHaveBeenCalled();
  });

  it('过期输出的敏感检查不能保存备份或重定向新请求', async () => {
    const gate = deferred<void>();
    mocks.quickCheck.mockImplementation(async (text: string) => {
      if (text.startsWith('{') && text.includes('"headline":"A 战报"')) {
        await gate.promise;
        return { ...safeCheck(text), hasSensitiveWords: true, detectedWords: ['危险符文'] };
      }
      return safeCheck(text);
    });
    mocks.dispatch.mockResolvedValueOnce(response('A')).mockResolvedValueOnce(response('B'));
    let pendingA!: Promise<void>;
    await act(async () => { pendingA = current.handleGenerate(); await waitForOutputCheck('A'); });
    await act(async () => current.handleGenerate());
    await act(async () => { gate.resolve(); await pendingA; });
    expect(mocks.backup).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    expect(useBattleStore.getState().newsReport).toMatchObject(report('B'));
  });

  it('A 的叙事历史过滤迟到时在真正落库前再次检查 owner', async () => {
    const gate = deferred<void>();
    mocks.quickCheck.mockImplementation(async (text: string) => {
      if (text === 'A 战报') await gate.promise;
      return safeCheck(text);
    });
    mocks.dispatch.mockResolvedValueOnce(response('A')).mockResolvedValueOnce(response('B'));
    let pendingA!: Promise<void>;
    await act(async () => { pendingA = current.handleGenerate(); await vi.waitFor(() => expect(mocks.quickCheck).toHaveBeenCalledWith('A 战报')); });
    await act(async () => current.handleGenerate());
    await act(async () => { gate.resolve(); await pendingA; });
    expect(useNarrativeHistoryStore.getState().entries.map(entry => entry.id)).toEqual(['arena-generation:generation-B']);
    expect(mocks.cooldown).toHaveBeenCalledOnce();
  });

  it('流式角色更新沿用请求 auth，旧更新失败不能污染后来的 B 结果', async () => {
    const update = deferred<void>(); mocks.update.mockReturnValueOnce(update.promise);
    await act(async () => useBattleStore.getState().setGenerationMode('stream'));
    mocks.openStream.mockResolvedValueOnce(new Response(
      sse('markdown', { chunk: '# A 战报\n\nA 正文' }) + sse('done', { status: 'completed', ok: true }),
      { headers: { 'Content-Type': 'text/event-stream', 'x-mahoshojo-generation-id': 'generation-A' } },
    ));
    let pendingA!: Promise<void>;
    await act(async () => { pendingA = current.handleGenerate(); await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce()); });
    const options = mocks.update.mock.calls[0][7];
    expect(options.auth.identity.isCurrent()).toBe(true); expect(options.canCommit()).toBe(true);
    await act(async () => useBattleStore.getState().setGenerationMode('non-stream'));
    mocks.dispatch.mockResolvedValueOnce(response('B'));
    await act(async () => current.handleGenerate());
    expect(options.canCommit()).toBe(false);
    await act(async () => { update.reject(new Error('A 迟到错误')); await pendingA; });
    expect(useBattleStore.getState()).toMatchObject({ newsReport: report('B'), error: null, isGenerating: false });
  });
});

describe('manual reconciliation result ownership', () => {
  it('换号后旧 retry 的错误不污染当前页面，但仍释放自己的 busy 和 mutation permit', async () => {
    const retry = deferred<void>(); mocks.retryUpdate.mockReturnValueOnce(retry.promise);
    await act(async () => useBattleStore.getState().setLastGenerationId('generation-A'));
    let pending!: Promise<void>;
    await act(async () => { pending = current.handleRetryUpdates(); await vi.waitFor(() => expect(mocks.retryUpdate).toHaveBeenCalledOnce()); });
    const [, , canCommit, auth] = mocks.retryUpdate.mock.calls[0];
    expect(canCommit()).toBe(true); expect(auth.identity.isCurrent()).toBe(true);
    localStorage.setItem(AUTH_STORAGE_KEY, 'another-account');
    expect(canCommit()).toBe(false);
    await act(async () => { retry.reject(new Error('旧账号更新失败')); await pending; });
    expect(useBattleStore.getState()).toMatchObject({ error: null, isRedoingUpdates: false, isCombatantMutationPending: false });
  });

  it('新生成 B 接管后旧 retry 的错误不覆盖 B 结果', async () => {
    const retry = deferred<void>(); mocks.retryUpdate.mockReturnValueOnce(retry.promise);
    await act(async () => useBattleStore.getState().setLastGenerationId('generation-A'));
    let pending!: Promise<void>;
    await act(async () => { pending = current.handleRetryUpdates(); await vi.waitFor(() => expect(mocks.retryUpdate).toHaveBeenCalledOnce()); });
    mocks.dispatch.mockResolvedValueOnce(response('B'));
    await act(async () => current.handleGenerate());
    expect(mocks.retryUpdate.mock.calls[0][2]()).toBe(false);
    await act(async () => { retry.reject(new Error('旧生成更新失败')); await pending; });
    expect(useBattleStore.getState()).toMatchObject({ error: null, newsReport: report('B'), isRedoingUpdates: false });
  });

  it('页面重置后新 retry 已接管时旧 finally 不能关闭新 retry busy 或 mutation permit', async () => {
    const retryA = deferred<void>(), retryB = deferred<void>();
    mocks.retryUpdate.mockReturnValueOnce(retryA.promise).mockReturnValueOnce(retryB.promise);
    await act(async () => useBattleStore.getState().setLastGenerationId('generation-A'));
    let pendingA!: Promise<void>, pendingB!: Promise<void>;
    await act(async () => { pendingA = current.handleRetryUpdates(); await vi.waitFor(() => expect(mocks.retryUpdate).toHaveBeenCalledTimes(1)); });
    await act(async () => useBattleStore.setState({ lastGenerationId: 'generation-B', isCombatantMutationPending: false, isRedoingUpdates: false }));
    await act(async () => { pendingB = current.handleRetryUpdates(); await vi.waitFor(() => expect(mocks.retryUpdate).toHaveBeenCalledTimes(2)); });
    await act(async () => { retryA.reject(new Error('A 已过期')); await pendingA; });
    expect(useBattleStore.getState()).toMatchObject({ error: null, isRedoingUpdates: true, isCombatantMutationPending: true });
    await act(async () => { retryB.resolve(); await pendingB; });
    expect(useBattleStore.getState()).toMatchObject({ error: null, isRedoingUpdates: false, isCombatantMutationPending: false });
  });

  it('合法 cookie bootstrap 的 owned identity 可继续重试，并保留 roster snapshot 屏障', async () => {
    mocks.ownedHeaders.mockImplementationOnce(async () => ({
      identity: beginAuthIdentityTransition().identity,
      headers: { 'x-mahoshojo-user-id': '42' },
    }));
    await act(async () => useBattleStore.getState().setLastGenerationId('generation-A'));
    const retry = deferred<void>(); mocks.retryUpdate.mockReturnValueOnce(retry.promise);
    let pending!: Promise<void>;
    await act(async () => { pending = current.handleRetryUpdates(); await vi.waitFor(() => expect(mocks.retryUpdate).toHaveBeenCalledOnce()); });
    const [, roster, canCommit, auth] = mocks.retryUpdate.mock.calls[0];
    expect(canCommit()).toBe(true); expect(auth.headers['x-mahoshojo-user-id']).toBe('42');
    await act(async () => useBattleStore.setState({ combatants: [{ ...roster[0], data: { name: '替换的角色' } }] }));
    expect(canCommit()).toBe(false);
    await act(async () => { retry.reject(new Error('上下文已变化')); await pending; });
    expect(useBattleStore.getState().error).toBeNull();
  });
});
