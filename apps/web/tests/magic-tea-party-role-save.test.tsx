// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMagicTeaPartySessions, type UseMagicTeaPartySessionsResult } from '@/lib/magic-tea-party/useMagicTeaPartySessions';
import type { MagicTeaPartyRole, MagicTeaPartySession } from '@/lib/magic-tea-party/types';

const host = vi.hoisted(() => ({ compare: vi.fn(), preserve: vi.fn(), read: vi.fn(), list: vi.fn(), messages: vi.fn(), put: vi.fn(), push: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: host.push }) }));
vi.mock('@/lib/magic-tea-party/migration', () => ({ migrateMagicTeaPartyLocalStorage: vi.fn() }));
vi.mock('@/lib/magic-tea-party/storage', async () => ({ ...(await vi.importActual('@/lib/magic-tea-party/storage')),
  compareAndReplaceMagicTeaPartyRole: host.compare, putMagicTeaPartySessionPreservingRoles: host.preserve, getMagicTeaPartySession: host.read,
  listMagicTeaPartySessions: host.list, listMagicTeaPartyMessages: host.messages, putMagicTeaPartySession: host.put,
}));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let root: Root;
let container: HTMLDivElement;
let state: UseMagicTeaPartySessionsResult;
let stored: Map<string, MagicTeaPartySession>;
let sessionA: MagicTeaPartySession;
let sessionB: MagicTeaPartySession;
let source: MagicTeaPartyRole;
let next: MagicTeaPartyRole;
function Harness() {
  state = useMagicTeaPartySessions({ userProviderConfig: null, onGlobalError: host.error });
  return null;
}
const select = async (id: string) => act(async () => { state.setActiveSessionId(id); });
const committed = () => ({ ...sessionA, roles: [next], updatedAt: 10 });

beforeEach(async () => {
  for (const mock of Object.values(host)) mock.mockReset();
  window.localStorage.clear();
  source = { id: 'role', name: '原角色', source: 'local', card: { name: '原角色', extension: { ownUndefined: undefined, utf16: '\uD800' } } };
  next = { ...source, name: '新角色', card: { ...source.card, name: '新角色' } };
  sessionA = { id: 'A', title: '会话 A', createdAt: 1, updatedAt: 2, roles: [source], summary: '原摘要',
    settings: { providerId: 'openai', modelId: 'test' } };
  sessionB = { ...sessionA, id: 'B', title: '会话 B', createdAt: 2, updatedAt: 1,
    roles: [{ ...source, name: 'B 角色', card: { name: 'B 角色' } }] };
  stored = new Map([[sessionA.id, sessionA], [sessionB.id, sessionB]]);
  host.list.mockImplementation(async () => [...stored.values()]);
  host.read.mockImplementation(async (id: string) => stored.get(id) ?? null);
  host.messages.mockResolvedValue([]);
  host.put.mockResolvedValue(undefined);
  host.preserve.mockImplementation(async (session: MagicTeaPartySession) => session);
  host.compare.mockResolvedValue(null);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(state.activeSession?.id).toBe('A');
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('Web awaited role save adapter', () => {
  it('keeps React state unchanged until the transaction receipt, then merges only the target role', async () => {
    const receipt = deferred<MagicTeaPartySession | null>();
    host.compare.mockReturnValueOnce(receipt.promise);
    let saving!: Promise<boolean>;
    await act(async () => { saving = state.saveActiveSessionRole(source, next); });
    expect(state.activeSession?.roles).toStrictEqual([source]);
    expect(state.sessions.find(item => item.id === 'A')?.roles).toStrictEqual([source]);
    expect(host.put).not.toHaveBeenCalled();
    expect(host.compare).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'A', createdAt: 1, source, next }));
    expect(host.compare.mock.calls[0][0].isCurrent()).toBe(true);
    host.preserve.mockImplementationOnce(async (session: MagicTeaPartySession) => ({ ...session, roles: session.roles.map(role => role.id === source.id ? next : role), updatedAt: 10 }));
    const other: MagicTeaPartyRole = { id: 'other', name: '其他角色', source: 'local', card: { future: [1] } };
    const latest = { ...sessionA, title: '保存期间改名', summary: '新摘要', draft: '新输入',
      settings: { ...sessionA.settings, temperature: 0.4, future: { keep: true } }, roles: [source, other], future: { keep: undefined } };
    const message = { id: 'message', sessionId: 'A', role: 'user' as const, content: '保留原文', createdAt: 1, future: { keep: true } };
    let persist!: Promise<void>;
    await act(async () => { persist = state.persistSession(latest); state.setMessages([message]); });
    await act(async () => { receipt.resolve(committed()); expect(await saving).toBe(true); await persist; });
    expect(state.activeSession).toStrictEqual({ ...latest, roles: [next, other], updatedAt: 10 });
    expect(state.sessions.find(item => item.id === 'A')).toStrictEqual(state.activeSession);
    expect(state.messages).toStrictEqual([message]);
    expect(state.sessions.find(item => item.id === 'B')).toStrictEqual(sessionB);
  });

  it.each(['conflict', 'failure'] as const)('keeps the original state on %s', async outcome => {
    if (outcome === 'conflict') host.compare.mockResolvedValueOnce(null);
    else host.compare.mockRejectedValueOnce(new Error('事务写入失败'));
    await act(async () => {
      if (outcome === 'conflict') expect(await state.saveActiveSessionRole(source, next)).toBe(false);
      else await expect(state.saveActiveSessionRole(source, next)).rejects.toThrow('事务写入失败');
    });
    expect(state.activeSession).toStrictEqual(sessionA);
    expect(state.sessions.find(item => item.id === 'A')).toStrictEqual(sessionA);
    expect(host.put).not.toHaveBeenCalled();
  });

  it.each(['B', 'A'] as const)('ignores a late A receipt after switching through B to %s', async destination => {
    const receipt = deferred<MagicTeaPartySession | null>();
    host.compare.mockReturnValueOnce(receipt.promise);
    let saving!: Promise<boolean>;
    await act(async () => { saving = state.saveActiveSessionRole(source, next); });
    const oldGuard = host.compare.mock.calls[0][0].isCurrent;
    await select('B');
    expect(state.activeSession).toStrictEqual(sessionB);
    expect(oldGuard()).toBe(false);
    if (destination === 'A') {
      const refreshed = { ...sessionA, summary: '重新进入时的摘要', roles: [{ ...source, name: '重新加载的角色' }] };
      stored.set('A', refreshed);
      await select('A');
      expect(state.activeSession).toStrictEqual(refreshed);
      expect(oldGuard()).toBe(false);
    }
    const before = state.activeSession;
    const listBefore = state.sessions;
    await act(async () => { receipt.resolve(committed()); expect(await saving).toBe(false); });
    expect(state.activeSession).toBe(before);
    expect(state.sessions).toBe(listBefore);
  });

  it('rejects a callback captured before A to B to A without opening storage', async () => {
    const oldSave = state.saveActiveSessionRole;
    await select('B'); await select('A');
    await act(async () => { expect(await oldSave(source, next)).toBe(false); });
    expect(host.compare).not.toHaveBeenCalled();
    expect(state.activeSession).toStrictEqual(sessionA);
  });

  it('serializes a newer same-session role update behind the earlier receipt', async () => {
    const receipt = deferred<MagicTeaPartySession | null>();
    host.compare.mockReturnValueOnce(receipt.promise);
    let saving!: Promise<boolean>;
    await act(async () => { saving = state.saveActiveSessionRole(source, next); });
    const newer = { ...source, notes: '另一次已保存修改', card: { ...source.card, extension: { ownUndefined: undefined, utf16: '\uD801' } } };
    const latest = { ...sessionA, roles: [newer], updatedAt: 20 };
    let persist!: Promise<void>;
    await act(async () => { persist = state.persistSession(latest, { sourceRoles: [source] }); });
    expect(host.preserve).not.toHaveBeenCalled();
    await act(async () => { receipt.resolve(committed()); await saving; await persist; });
    expect(state.activeSession).toStrictEqual(latest);
    expect(state.sessions.find(item => item.id === 'A')).toStrictEqual(latest);
  });

  it('does not reinsert a session removed from the latest list while its receipt is pending', async () => {
    const receipt = deferred<MagicTeaPartySession | null>();
    host.compare.mockReturnValueOnce(receipt.promise);
    let saving!: Promise<boolean>;
    await act(async () => { saving = state.saveActiveSessionRole(source, next); });
    stored.delete('A');
    await act(async () => state.handleSessionImported('B'));
    expect(state.sessions.map(item => item.id)).toEqual(['B']);
    await act(async () => { receipt.resolve(committed()); expect(await saving).toBe(false); });
    expect(state.sessions).toStrictEqual([sessionB]);
    expect(state.activeSession).toStrictEqual(sessionB);
  });
});
