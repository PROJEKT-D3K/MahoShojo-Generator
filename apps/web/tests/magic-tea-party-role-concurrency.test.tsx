// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMagicTeaPartySessions, type UseMagicTeaPartySessionsResult } from '@/lib/magic-tea-party/useMagicTeaPartySessions';
import {
  deleteMagicTeaPartySession, getMagicTeaPartySession, listMagicTeaPartyMessages,
  putMagicTeaPartyMessage, putMagicTeaPartySession, putMagicTeaPartySessionPreservingRoles,
} from '@/lib/magic-tea-party/storage';
import type { MagicTeaPartyRole, MagicTeaPartySession } from '@/lib/magic-tea-party/types';

const host = vi.hoisted(() => ({ push: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: host.push }) }));
vi.mock('@/lib/magic-tea-party/migration', () => ({ migrateMagicTeaPartyLocalStorage: vi.fn() }));
// Deliberately no storage mock: hook callbacks, request events, transactions and readback are real.
let root: Root;
let container: HTMLDivElement;
let state: UseMagicTeaPartySessionsResult;
let sessionA: MagicTeaPartySession;
let sessionB: MagicTeaPartySession;
let releaseHeldTransaction: (() => void) | undefined;
function Harness() {
  state = useMagicTeaPartySessions({ userProviderConfig: null, onGlobalError: host.error });
  return null;
}
const rename = (role: MagicTeaPartyRole, name: string): MagicTeaPartyRole => ({ ...role, name, card: { ...role.card, name } });
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 1));
async function awaitActive(id: string) {
  const deadline = Date.now() + 5_000;
  while (state.activeSession?.id !== id && Date.now() < deadline) await act(nextTurn);
  expect(state.activeSession?.id).toBe(id);
}
async function assertRoleCopies(expected: MagicTeaPartyRole[], id = sessionA.id) {
  const stored = await getMagicTeaPartySession(id);
  expect(stored?.roles).toStrictEqual(expected);
  expect(state.activeSession?.id).toBe(id);
  expect(state.activeSession?.roles).toStrictEqual(expected);
  expect(state.sessions.find(item => item.id === id)?.roles).toStrictEqual(expected);
  return stored!;
}
const receiptGate = (name: string) => {
  let ready!: () => void;
  const written = new Promise<void>(resolve => { ready = resolve; });
  let captured = false;
  let released = false;
  releaseHeldTransaction = () => { released = true; };
  const originalPut = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = originalPut.call(this, value, key);
    if (!captured && this.name === 'sessions' && value.id === sessionA.id
      && value.roles.some((role: MagicTeaPartyRole) => role.name === name)) {
      captured = true;
      request.addEventListener('success', () => {
        // Real reads keep this real transaction pending; its write still commits or aborts normally.
        const keepAlive = () => {
          const read = this.get(sessionA.id);
          read.addEventListener('success', () => { if (!released) keepAlive(); });
        };
        keepAlive(); ready();
      });
    }
    return request;
  });
  return { written, release: () => releaseHeldTransaction?.() };
};

beforeEach(async () => {
  host.error.mockReset(); host.push.mockReset(); window.localStorage.clear(); releaseHeldTransaction = undefined;
  const first: MagicTeaPartyRole = { id: 'role-a', name: '角色 A', source: 'local', card: { name: '角色 A', extension: { ownUndefined: undefined, utf16: '\uD800' } } };
  const second: MagicTeaPartyRole = { id: 'role-b', name: '角色 B', source: 'local', card: { name: '角色 B', future: ['原件'] } };
  sessionA = { id: crypto.randomUUID(), title: '会话 A', createdAt: 1, updatedAt: 2, roles: [first, second], summary: '原摘要',
    settings: { providerId: 'openai', modelId: 'test' } };
  sessionB = { ...sessionA, id: crypto.randomUUID(), title: '会话 B', createdAt: 2, updatedAt: 1,
    roles: [{ ...first, id: 'b-only', name: 'B 会话角色' }], pinnedAt: 1, pinnedOrder: 1 };
  await putMagicTeaPartySession(sessionA); await putMagicTeaPartySession(sessionB);
  window.localStorage.setItem('magic-tea-party:recent-session', sessionA.id);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />)); await awaitActive(sessionA.id);
});
afterEach(async () => {
  releaseHeldTransaction?.(); vi.restoreAllMocks();
  await act(async () => root.unmount()); container.remove();
  await deleteMagicTeaPartySession(sessionA.id); await deleteMagicTeaPartySession(sessionB.id);
});

describe('real Web hook and IndexedDB role concurrency', () => {
  it('keeps the saved role in storage, active UI and list when a same-act title write captures the old session', async () => {
    const captured = state;
    const original = captured.activeSession!;
    const next = rename(original.roles[0], '保存后的角色 A');
    let saved!: boolean;
    await act(async () => {
      const receipt = captured.saveActiveSessionRole(original.roles[0], next);
      captured.updateSessionTitle('同一事件的新标题');
      saved = await receipt;
      await getMagicTeaPartySession(sessionA.id); // Queued read waits for the title transaction too.
    });
    expect(saved).toBe(true);
    const stored = await assertRoleCopies([next, original.roles[1]]);
    expect(stored.title).toBe('同一事件的新标题'); expect(state.activeSession?.title).toBe(stored.title);
    expect(state.sessions.find(item => item.id === sessionA.id)?.title).toBe(stored.title);
    expect(host.error).not.toHaveBeenCalled();
  });

  it('keeps the saved role when a 400ms draft save uses its captured old session', async () => {
    const captured = state;
    const original = captured.activeSession!;
    const next = rename(original.roles[0], '定时保存仍保留的新角色');
    const message = { id: `${sessionA.id}-original`, sessionId: sessionA.id, role: 'user' as const,
      content: '原始消息\uD800', createdAt: 1, meta: { extension: { keep: undefined } } };
    await putMagicTeaPartyMessage(message);
    let saved!: boolean;
    await act(async () => {
      const receipt = captured.saveActiveSessionRole(original.roles[0], next);
      const debounced = new Promise<void>((resolve, reject) => setTimeout(() => {
        void captured.persistSession({ ...original, draft: '延迟写入的输入草稿', updatedAt: Date.now() }).then(resolve, reject);
      }, 400));
      [saved] = await Promise.all([receipt, debounced]);
    });
    expect(saved).toBe(true);
    const stored = await assertRoleCopies([next, original.roles[1]]);
    expect(stored.draft).toBe('延迟写入的输入草稿'); expect(state.activeSession?.draft).toBe(stored.draft);
    expect(state.sessions.find(item => item.id === sessionA.id)?.draft).toBe(stored.draft);
    expect(await listMagicTeaPartyMessages(sessionA.id)).toStrictEqual([message]);
  });

  it('commits two different roles concurrently without dropping either receipt', async () => {
    const captured = state;
    const original = captured.activeSession!;
    const first = rename(original.roles[0], '并发角色 A');
    const second = rename(original.roles[1], '并发角色 B');
    let receipts!: boolean[];
    await act(async () => { receipts = await Promise.all([
      captured.saveActiveSessionRole(original.roles[0], first), captured.saveActiveSessionRole(original.roles[1], second),
    ]); });
    expect(receipts).toEqual([true, true]); await assertRoleCopies([first, second]);
  });

  it.each(['pin', 'reorder'] as const)('retains a role edit interleaved with %s persistence', async action => {
    if (action === 'reorder') await act(async () => state.toggleSessionPin(sessionA.id));
    const captured = state;
    const original = captured.activeSession!;
    const next = rename(original.roles[0], `交错 ${action} 的新角色`);
    let saved!: boolean;
    await act(async () => {
      const receipt = captured.saveActiveSessionRole(original.roles[0], next);
      const otherWrite = action === 'pin' ? captured.toggleSessionPin(sessionA.id)
        : captured.reorderPinnedSessions([sessionB.id, sessionA.id]);
      [saved] = await Promise.all([receipt, otherWrite]);
    });
    expect(saved).toBe(true);
    const stored = await assertRoleCopies([next, original.roles[1]]);
    expect(stored.pinnedAt).toBeGreaterThan(0);
    expect(stored.pinnedOrder).toBe(action === 'pin' ? 2 : 1);
    expect(state.activeSession?.pinnedOrder).toBe(stored.pinnedOrder);
    expect(state.sessions.find(item => item.id === sessionA.id)?.pinnedOrder).toBe(stored.pinnedOrder);
    expect((await getMagicTeaPartySession(sessionB.id))?.roles).toStrictEqual(sessionB.roles);
  });

  it('preserves latest role bodies through an explicitly reordered stale role list', async () => {
    const captured = state;
    const original = captured.activeSession!;
    const next = rename(original.roles[0], '换序仍保留的新角色');
    await act(async () => {
      const receipt = captured.saveActiveSessionRole(original.roles[0], next);
      const reorder = captured.updateActiveSessionRoles([original.roles[1], original.roles[0]]);
      expect(await receipt).toBe(true); await reorder;
    });
    await assertRoleCopies([original.roles[1], next]);
  });

  it('rejects an explicit stale replacement rather than overwriting the separately committed role', async () => {
    const captured = state;
    const original = captured.activeSession!;
    const next = rename(original.roles[0], '先提交的角色');
    let results!: PromiseSettledResult<unknown>[];
    await act(async () => {
      results = await Promise.allSettled([
        captured.saveActiveSessionRole(original.roles[0], next),
        captured.updateActiveSessionRoles([rename(original.roles[0], '过时列表覆盖'), original.roles[1]]),
      ]);
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: true });
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') expect(String(results[1].reason)).toContain('角色已变化');
    await assertRoleCopies([next, original.roles[1]]);
  });

  it.each([false, true])('isolates a real pending role transaction while switching A to B, returning to A=%s', async returnToA => {
    const captured = state;
    const original = captured.activeSession!;
    const next = rename(original.roles[0], '原会话已写入的角色');
    const gate = receiptGate(next.name);
    let saving!: Promise<boolean>;
    await act(async () => { saving = captured.saveActiveSessionRole(original.roles[0], next); await gate.written; });
    await act(async () => state.setActiveSessionId(sessionB.id));
    expect(state.activeSessionId).toBe(sessionB.id);
    // This later real transaction is queued before the next A load; it owns the new title/summary.
    const laterFields = putMagicTeaPartySessionPreservingRoles({ ...original, title: '重新进入后的标题',
      summary: '重新进入后的摘要', settings: { ...original.settings, temperature: 0.7 }, updatedAt: Date.now() });
    if (returnToA) await act(async () => state.setActiveSessionId(sessionA.id));
    await act(async () => { gate.release(); expect(await saving).toBe(false); await laterFields; });
    await awaitActive(returnToA ? sessionA.id : sessionB.id);
    await act(async () => state.handleSessionImported(returnToA ? sessionA.id : sessionB.id));
    expect(state.activeSessionId).toBe(returnToA ? sessionA.id : sessionB.id);
    const stored = await getMagicTeaPartySession(sessionA.id);
    expect(stored?.roles).toStrictEqual([next, original.roles[1]]);
    expect(stored).toMatchObject({ title: '重新进入后的标题', summary: '重新进入后的摘要', settings: { temperature: 0.7 } });
    expect(state.sessions.find(item => item.id === sessionA.id)).toMatchObject({ title: stored!.title, summary: stored!.summary, roles: stored!.roles });
    if (returnToA) {
      await assertRoleCopies([next, original.roles[1]]);
      expect(state.activeSession).toMatchObject({ title: stored!.title, summary: stored!.summary, settings: { temperature: 0.7 } });
    } else expect(state.activeSession).toStrictEqual(sessionB);
  });

  it('propagates a genuine transaction abort without a true receipt or optimistic role change', async () => {
    const original = state.activeSession!;
    const next = rename(original.roles[0], '不能确认成功的角色');
    const originalPut = IDBObjectStore.prototype.put;
    let aborted = false;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      if (this.name === 'sessions' && value.id === sessionA.id) request.addEventListener('success', () => {
        aborted = true; this.transaction.abort();
      });
      return request;
    });
    await act(async () => { await expect(state.saveActiveSessionRole(original.roles[0], next)).rejects.toThrow('保存角色失败'); });
    expect(aborted).toBe(true); await assertRoleCopies(original.roles);
    expect(await getMagicTeaPartySession(sessionA.id)).toStrictEqual(original);
  });

  it('queues a role CAS until an already committed ordinary transaction has delivered its old receipt', async () => {
    const original = state.activeSession!;
    const next = rename(original.roles[0], '旧普通回执之后的新角色');
    const originalTransaction = IDBDatabase.prototype.transaction;
    let capture = true;
    let writeTransactions = 0;
    let completed!: () => void;
    const ordinaryCompleted = new Promise<void>(resolve => { completed = resolve; });
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, stores, mode, options) {
      const transaction = originalTransaction.call(this, stores, mode, options);
      if (mode === 'readwrite') writeTransactions += 1;
      if (capture && mode === 'readwrite') {
        capture = false;
        let handler: IDBTransaction['oncomplete'] = null;
        Object.defineProperty(transaction, 'oncomplete', {
          configurable: true,
          set(value: IDBTransaction['oncomplete']) { handler = value; },
          get() {
            return (event: Event) => {
              // The actual transaction is committed; withhold only delivery to its original observer.
              let delivered = false;
              releaseHeldTransaction = () => {
                if (delivered) return;
                delivered = true; handler?.call(transaction, event);
              };
              completed();
            };
          },
        });
      }
      return transaction;
    });
    let ordinary!: Promise<void>;
    let ordinarySettled = false;
    await act(async () => {
      ordinary = state.persistSession({ ...original, title: '普通事务已提交的新标题' });
      void ordinary.then(() => { ordinarySettled = true; });
      await ordinaryCompleted;
    });
    const beforeRole = await getMagicTeaPartySession(sessionA.id);
    expect(beforeRole?.title).toBe('普通事务已提交的新标题');
    expect(beforeRole?.roles).toStrictEqual(original.roles);
    expect(ordinarySettled).toBe(false);
    let saving!: Promise<boolean>;
    let roleSettled = false;
    await act(async () => {
      saving = state.saveActiveSessionRole(original.roles[0], next);
      void saving.then(() => { roleSettled = true; }, () => { roleSettled = true; });
      await nextTurn();
      await getMagicTeaPartySession(sessionA.id);
    });
    expect(roleSettled).toBe(false);
    expect(writeTransactions).toBe(1);
    await assertRoleCopies(original.roles);
    expect(ordinarySettled).toBe(false);
    // Release first: awaiting the queued CAS before this would intentionally deadlock.
    await act(async () => {
      releaseHeldTransaction!();
      await ordinary;
      expect(await saving).toBe(true);
    });
    expect(ordinarySettled).toBe(true); expect(roleSettled).toBe(true); expect(writeTransactions).toBe(2);
    const stored = await assertRoleCopies([next, original.roles[1]]);
    expect(stored.title).toBe('普通事务已提交的新标题');
    expect(state.activeSession?.title).toBe(stored.title);
    expect(state.sessions.find(item => item.id === sessionA.id)?.title).toBe(stored.title);
  });

});
