import { describe, expect, it, vi } from 'vitest';
import { buildMagicTeaPartySessionExport } from '@mahoshojo/domain/magic-tea-party/transfer';
import { prepareDesktopTeaImport, exportDesktopTea } from '../src/features/magic-tea-party/transfer';
import type { TeaNativePort } from '../src/platform/magic-tea-party-native';
import { TeaMessageDocumentSchema, type TeaReadRequest, type TeaReadResponse } from '@mahoshojo/contracts/desktop-magic-tea-party';
const archive = () => buildMagicTeaPartySessionExport({ session: { id: 'old', title: '原茶会', roles: [{ id: 'r', name: '角色', source: 'local', card: { name: '角色', future: { attachments: ['inert'] }, avatarUrl: 'https://invalid.example/avatar' } }], createdAt: 1, updatedAt: 1,
  settings: { providerId: 'old', modelId: 'old-model', enableSummary: true, writeArenaHistory: true, writeCurrentState: true, updateApplyMode: 'auto', outputPlan: { choices: 'on', summary: 'on', updates: 'on' } } },
  messages: [{ id: 'm', sessionId: 'old', role: 'assistant', content: '中😀', createdAt: 2, meta: { future: { tachieId: 'inert' } } }] });
const ids = () => { let next = 0; return () => `new-${++next}`; };
describe('Desktop text Tea transfer host', () => {
  it('roundtrips legacy and canonical reasoning metadata without a display migration or write', async () => {
    const value = archive();
    value.messages[0]!.meta = { reasoningText: '  旧思考😀  ', aiReasoning: { status: 'done', source: 'provider', text: 'canonical' }, future: { untouched: true } };
    const before = JSON.stringify(value);
    const plan = prepareDesktopTeaImport(before, 'json', ids(), 5);
    if (plan.write.request.action !== 'import') throw new Error('bad fixture');
    const entry = plan.write.request.entries[0]!; const instance = 'a'.repeat(32);
    const port: TeaNativePort = { mutate: vi.fn(), read: vi.fn(async (input: TeaReadRequest): Promise<TeaReadResponse> => {
      if (input.request.action === 'session') return { version: 1, result: { action: 'session', catalogRevision: 1, record: { session: entry.session, instance, revision: 1 } } };
      return { version: 1, result: { action: 'messages', catalogRevision: 1, sessionId: entry.session.id, instance, revision: 1,
        rows: entry.messages.map((message, index) => ({ ordinal: index + 1, message })), nextCursor: null } };
    }) };
    const imported = JSON.stringify(entry);
    expect(JSON.parse(await exportDesktopTea(port, entry.session.id, 'json', () => true)).messages[0].meta).toEqual(value.messages[0]!.meta);
    expect(JSON.stringify(entry)).toBe(imported); expect(JSON.stringify(value)).toBe(before); expect(port.mutate).not.toHaveBeenCalled();
  });

  it('preserves imported known settings and inert nested extensions, using capability projection only at execution', () => {
    const value = archive(); const text = JSON.stringify(value);
    const plan = prepareDesktopTeaImport(text, 'json', ids(), 5);
    expect(plan.write.request.action).toBe('import');
    if (plan.write.request.action !== 'import') throw new Error('bad fixture');
    const entry = plan.write.request.entries[0]!;
    expect(entry.session.settings).toMatchObject(value.session.settings);
    expect(entry.session.roles[0]?.card).toEqual(value.roles[0]?.card);
    expect(entry.messages[0]?.meta).toEqual(value.messages[0]?.meta);
    expect(JSON.stringify(value)).toBe(text);
  });
  it('rejects known media before any write, including both original JSONL extra spellings', () => {
    const value = archive(); value.tachieAssets = [{ id: 'asset', sessionId: 'old', cacheKey: 'c', fragmentHash: 'f', styleId: 's', createdAt: 1, lastUsedAt: 1 }];
    expect(() => prepareDesktopTeaImport(JSON.stringify(value), 'json', ids(), 5)).toThrow('媒体');
    for (const key of ['magic_tea_party', 'magic_tavern']) expect(() => prepareDesktopTeaImport(JSON.stringify({ mes: 'text', extra: { [key]: { tachieId: 'missing-asset' } } }), 'jsonl', ids(), 5)).toThrow('媒体');
  });
  it('checks both JSONL attachment aliases independently and recurses through legacy archives', () => {
    expect(() => prepareDesktopTeaImport(JSON.stringify({ mes: 'text', extra: { magic_tea_party: {}, magic_tavern: { tachieId: 'media' } } }), 'jsonl', ids(), 5)).toThrow('媒体');
    const value = archive(); value.messages[0]!.tachieId = 'media';
    expect(() => prepareDesktopTeaImport(JSON.stringify({ schema: 'magic-tavern.archive.v1', sessions: [value] }), 'json', ids(), 5)).toThrow('媒体');
  });
  it('rejects preserved JSONL attachment slots inside the real Web meta.sillyTavern archive location', () => {
    for (const extra of [{ magic_tea_party: { tachieId: 'image' } }, { magic_tea_party: {}, magic_tavern: { tachieId: 'image' } }]) {
      const value = archive(); value.messages[0]!.meta = { sillyTavern: { extra } };
      expect(() => prepareDesktopTeaImport(JSON.stringify(value), 'json', ids(), 5)).toThrow('媒体');
    }
    const value = archive(); value.messages[0]!.meta = { future: { tachieId: 'inert' } };
    expect(prepareDesktopTeaImport(JSON.stringify(value), 'json', ids(), 5).write.request.action).toBe('import');
  });
  it('passes the selected player role name to the original JSONL serializer', async () => {
    const value = archive(); const session = { ...value.session, roles: value.roles, playerRoleId: 'r' }; const instance = 'a'.repeat(32);
    const port: TeaNativePort = { mutate: vi.fn(), read: vi.fn(async (input: TeaReadRequest): Promise<TeaReadResponse> => {
      if (input.request.action === 'session') return { version: 1, result: { action: 'session', catalogRevision: 1, record: { session, instance, revision: 1 } } };
      return { version: 1, result: { action: 'messages', catalogRevision: 1, sessionId: session.id, instance, revision: 1,
        rows: [{ ordinal: 1, message: { id: 'user', sessionId: session.id, role: 'user', content: '台词', createdAt: 1 } }], nextCursor: null } };
    }) };
    const text = await exportDesktopTea(port, session.id, 'jsonl', () => true);
    expect(text.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(line => line.mes === '台词')).toMatchObject({ name: '角色', is_user: true });
  });
  it('rejects an all-session export exceeding the whole import message budget without producing a partial archive', async () => {
    const instance = 'a'.repeat(32); const base = archive();
    const port: TeaNativePort = { mutate: vi.fn(), read: vi.fn(async (input: TeaReadRequest): Promise<TeaReadResponse> => {
      const request = input.request;
      if (request.action === 'list') return { version: 1, result: { action: 'list', catalogRevision: 1, nextCursor: null,
        rows: ['one', 'two'].map(id => ({ id, instance, revision: 1, title: id, titleTruncated: false, pinnedAt: 0, pinnedOrder: 0, createdAt: 1, updatedAt: 1, messageCount: 5001, roleCount: 0, roleNames: [], scenarioTitle: null })) } };
      if (request.action === 'session') return { version: 1, result: { action: 'session', catalogRevision: 1, record: { instance, revision: 1, session: { ...base.session, id: request.sessionId, roles: [] } } } };
      if (request.action !== 'messages') throw new Error('unexpected');
      const start = request.cursor?.ordinal ?? 0; const count = Math.min(100, 5001 - start);
      const rows = Array.from({ length: count }, (_, index) => { const ordinal = start + index + 1; return { ordinal,
        message: { id: `${request.sessionId}-${ordinal}`, sessionId: request.sessionId, role: 'user' as const, content: 'x', createdAt: 1 } }; });
      const last = rows.at(-1)!;
      return { version: 1, result: { action: 'messages', catalogRevision: 1, sessionId: request.sessionId, instance, revision: 1,
        rows, nextCursor: last.ordinal < 5001 ? { ordinal: last.ordinal, id: last.message.id } : null } };
    }) };
    await expect(exportDesktopTea(port, null, 'archive', () => true)).rejects.toThrow('10000');
    expect(port.mutate).not.toHaveBeenCalled();
  });
  it('exports all revision-fenced pages and fails the whole export on a later catalog change', async () => {
    const value = archive(); const session = { ...value.session, roles: value.roles }; const instance = 'a'.repeat(32);
    const read = vi.fn(async (input: TeaReadRequest): Promise<TeaReadResponse> => {
      const request = input.request;
      if (request.action === 'session') return { version: 1, result: { action: 'session', catalogRevision: 7, record: { session, instance, revision: 2 } } };
      if (request.action !== 'messages') throw new Error('unexpected');
      expect(request).toMatchObject({ expectedCatalogRevision: 7, expectedRevision: 2, instance });
      const ordinal = request.cursor ? 2 : 1;
      return { version: 1, result: { action: 'messages', catalogRevision: 7, sessionId: 'old', instance, revision: 2,
        rows: [{ ordinal, message: TeaMessageDocumentSchema.parse({ ...value.messages[0]!, id: `m${ordinal}` }) }], nextCursor: ordinal === 1 ? { ordinal, id: 'm1' } : null } };
    });
    const port: TeaNativePort = { read, mutate: vi.fn() };
    const text = await exportDesktopTea(port, 'old', 'json', () => true);
    expect(JSON.parse(text).messages.map((message: { id: string }) => message.id)).toEqual(['m1', 'm2']);
    const original = read.getMockImplementation()!;
    read.mockImplementation(async input => { if (input.request.action === 'messages' && input.request.cursor) throw new Error('tea-conflict'); return original(input); });
    await expect(exportDesktopTea(port, 'old', 'json', () => true)).rejects.toThrow('tea-conflict');
    expect(port.mutate).not.toHaveBeenCalled();
  });
});
