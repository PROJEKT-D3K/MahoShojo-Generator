// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareAndReplaceMagicTeaPartyRole, deleteMagicTeaPartySession, getMagicTeaPartySession,
  listMagicTeaPartyMessages, putMagicTeaPartyMessage, putMagicTeaPartySession, putMagicTeaPartySessionPreservingRoles,
} from '@/lib/magic-tea-party/storage';
import type { MagicTeaPartyRole, MagicTeaPartySession } from '@/lib/magic-tea-party/types';

let session: MagicTeaPartySession;
let source: MagicTeaPartyRole;
let next: MagicTeaPartyRole;
const save = (isCurrent = () => true) => compareAndReplaceMagicTeaPartyRole({
  sessionId: session.id, createdAt: session.createdAt, source, next, isCurrent,
});

beforeEach(async () => {
  source = { id: 'role', name: '原角色', source: 'cloud', dataCardId: 'original-card', signature: 'original-signature',
    origin: { fileName: 'original.json' }, card: { name: '原角色', signature: 'card-signature',
      current_state: { summary: '原状态', fields: [{ label: '保留', value: '字段' }], future: { keep: true } },
      ownUndefined: undefined, utf16: '\uD800', extension: { nested: [1, '保留'] } } };
  next = { ...source, name: '新角色', notes: '新备注', card: { ...source.card, name: '新角色' } };
  session = { id: crypto.randomUUID(), title: '茶会', createdAt: 1, updatedAt: 1, roles: [source],
    settings: { providerId: 'openai', modelId: 'test' } };
  await putMagicTeaPartySession(session);
});
afterEach(() => vi.restoreAllMocks());

describe('Web role-only IndexedDB conditional save', () => {
  it('acknowledges transaction completion, never only the successful put request', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    let transactionComplete = false;
    let settled = false;
    let atRequest: { settled: boolean; transactionComplete: boolean } | undefined;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      this.transaction.addEventListener('complete', () => { transactionComplete = true; });
      request.addEventListener('success', () => { atRequest = { settled, transactionComplete }; });
      return request;
    });
    const pending = save().then(result => { settled = true; return result; });
    const committed = await pending;
    expect(atRequest).toEqual({ settled: false, transactionComplete: false });
    expect(transactionComplete).toBe(true);
    expect(committed?.roles[0]).toStrictEqual(next);
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(committed);
  });

  it('rejects an aborted transaction after put success and keeps the complete original', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(save()).rejects.toThrow('保存角色失败');
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(session);
  });

  it('preserves latest unrelated session, settings, roles and complete message extensions', async () => {
    const other: MagicTeaPartyRole = { id: 'other', name: '其他角色', source: 'local', card: { future: { untouched: true } } };
    const latest = { ...session, title: '别处改名', summary: '最新摘要', draft: '未发送输入',
      summaryMeta: { updatedAt: 8, future: { preserve: true } },
      settings: { ...session.settings, temperature: 0.2, future: { original: undefined } },
      roles: [source, other], future: { utf16: '\uD800', ownUndefined: undefined } };
    const message = { id: `${session.id}-message`, sessionId: session.id, role: 'user' as const,
      content: '完整原文\uD800', createdAt: 2, meta: { extension: { ownUndefined: undefined } }, future: ['保留'] };
    await putMagicTeaPartySession(latest);
    await putMagicTeaPartyMessage(message);
    const committed = await save();
    expect(committed).toStrictEqual({ ...latest, roles: [next, other], updatedAt: expect.any(Number) });
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(committed);
    expect(await listMagicTeaPartyMessages(session.id)).toStrictEqual([message]);
    expect(Object.hasOwn(committed!.roles[0].card, 'ownUndefined')).toBe(true);
    expect((committed!.roles[0].card.utf16 as string).charCodeAt(0)).toBe(0xD800);
    expect(committed!.roles[0]).toMatchObject({ source: 'cloud', dataCardId: 'original-card', signature: 'original-signature' });
  });

  it.each(['source', 'nested', 'undefined', 'utf16'] as const)('rejects a complete-source conflict in %s', async change => {
    let current = { ...source, card: { ...source.card } };
    if (change === 'source') current = { ...current, source: 'local' };
    if (change === 'nested') current.card.extension = { nested: [1, '别处修改'] };
    if (change === 'undefined') delete current.card.ownUndefined;
    if (change === 'utf16') current.card.utf16 = '\uFFFD';
    const latest = { ...session, roles: [current] };
    await putMagicTeaPartySession(latest);
    expect(await save()).toBeNull();
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(latest);
  });

  it.each(['role', 'session', 'incarnation', 'duplicate'] as const)('does not resurrect or replace a missing/changed %s', async change => {
    if (change === 'session') await deleteMagicTeaPartySession(session.id);
    else await putMagicTeaPartySession({ ...session,
      createdAt: change === 'incarnation' ? session.createdAt + 1 : session.createdAt,
      roles: change === 'role' ? [] : change === 'duplicate' ? [source, { ...source }] : session.roles });
    const before = await getMagicTeaPartySession(session.id);
    expect(await save()).toBeNull();
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(before);
  });

  it('rechecks owner identity inside the transaction and refuses changed target IDs', async () => {
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await save(isCurrent)).toBeNull();
    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(await compareAndReplaceMagicTeaPartyRole({ sessionId: session.id, createdAt: session.createdAt,
      source, next: { ...next, id: 'different' }, isCurrent: () => true })).toBeNull();
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(session);
  });

  it('allows only one concurrent replacement of the same original role', async () => {
    const results = await Promise.all([save(), save()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getMagicTeaPartySession(session.id))?.roles).toStrictEqual([next]);
  });
});

describe('existing-session writers preserve committed roles', () => {
  it('keeps the saved role when an old title/draft snapshot is written after its receipt', async () => {
    await save();
    const committed = await putMagicTeaPartySessionPreservingRoles({ ...session, title: '新标题', draft: '自动保存输入' });
    expect(committed.roles).toStrictEqual([next]);
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(committed);
    expect(committed).toMatchObject({ title: '新标题', draft: '自动保存输入' });
  });

  it('merges distinct changed roles and keeps concurrent order and additions', async () => {
    const other = { ...source, id: 'other', name: '其他' };
    const added = { ...source, id: 'added', name: '并行新增' };
    const otherNext = { ...other, notes: '另一角色修改' };
    const original = { ...session, roles: [source, other] };
    await putMagicTeaPartySession({ ...original, roles: [other, next, added] });
    const committed = await putMagicTeaPartySessionPreservingRoles({ ...original, roles: [source, otherNext] }, { sourceRoles: original.roles });
    expect(committed.roles).toStrictEqual([otherNext, next, added]);
  });

  it('applies explicit reorder without resurrecting a concurrently removed unchanged role', async () => {
    const other = { ...source, id: 'other' }; const third = { ...source, id: 'third' }; const added = { ...source, id: 'added' };
    const original = { ...session, roles: [source, other, third] };
    await putMagicTeaPartySession({ ...original, roles: [next, third, added] });
    const committed = await putMagicTeaPartySessionPreservingRoles({ ...original, roles: [third, other, source] }, { sourceRoles: original.roles });
    expect(committed.roles).toStrictEqual([third, next, added]);
  });

  it('applies explicit additions/deletions while retaining an unrelated saved role', async () => {
    const other = { ...source, id: 'other' }; const added = { ...source, id: 'added' };
    const original = { ...session, roles: [source, other] };
    await putMagicTeaPartySession({ ...original, roles: [next, other] });
    const committed = await putMagicTeaPartySessionPreservingRoles({ ...original, roles: [source, added] }, { sourceRoles: original.roles });
    expect(committed.roles).toStrictEqual([next, added]);
  });

  it.each(['change', 'remove'] as const)('rejects stale same-role %s atomically', async mode => {
    await save();
    await expect(putMagicTeaPartySessionPreservingRoles({ ...session, title: '不可半写', roles: mode === 'remove' ? [] : [{ ...source, notes: '过时' }] },
      { sourceRoles: session.roles })).rejects.toThrow('角色已变化');
    const stored = await getMagicTeaPartySession(session.id);
    expect(stored?.title).toBe(session.title); expect(stored?.roles).toStrictEqual([next]);
  });

  it('rejects duplicate role identities and conflicting additions', async () => {
    await expect(putMagicTeaPartySessionPreservingRoles({ ...session, roles: [source, source] }, { sourceRoles: session.roles })).rejects.toThrow('角色已变化');
    await expect(putMagicTeaPartySessionPreservingRoles(session, { sourceRoles: [] })).rejects.toThrow('角色已变化');
  });

  it('does not resurrect a deleted or replaced session', async () => {
    await deleteMagicTeaPartySession(session.id);
    await expect(putMagicTeaPartySessionPreservingRoles(session)).rejects.toThrow('会话已删除');
    await putMagicTeaPartySession({ ...session, createdAt: 99 });
    await expect(putMagicTeaPartySessionPreservingRoles(session)).rejects.toThrow('会话已删除或替换');
  });

  it('rejects after a successful put request if the actual transaction aborts', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort()); return request;
    });
    await expect(putMagicTeaPartySessionPreservingRoles({ ...session, title: '不可假成功' })).rejects.toThrow('保存会话失败');
    expect(await getMagicTeaPartySession(session.id)).toStrictEqual(session);
  });
});
