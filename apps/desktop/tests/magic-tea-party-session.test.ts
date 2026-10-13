import { describe, expect, it, vi } from 'vitest';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import type { TeaReadResponse, TeaWriteRequest, TeaWriteResponse, TeaSessionDocument, TeaMessageDocument } from '@mahoshojo/contracts/desktop-magic-tea-party';
import { DesktopTeaSession } from '../src/features/magic-tea-party/session';
import { createIpcTeaNativePort } from '../src/platform/magic-tea-party-native';
import type { ResolvedDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';

const target: ResolvedDesktopAiTarget = { location: 'client', providerTarget: { kind: 'custom', profileId: 'tea-loopback' }, profile: null, mode: 'direct-local', modelId: 'synthetic', availableModelIds: [], generationOverrides: undefined, unavailableReason: null };
const baseSession = (): TeaSessionDocument => ({ id: 's', title: '茶会', createdAt: 1, updatedAt: 1, roles: [], settings: { providerId: 'openai', modelId: 'm' }, draft: '' });
const harness = () => {
  let record: { session: TeaSessionDocument; instance: string; revision: number } | null = { session: baseSession(), instance: 'a'.repeat(32), revision: 1 };
  let messages: TeaMessageDocument[] = []; let drop: string | null = null; let fail: string | null = null;
  let count = 0; let sequence = 0; const receipts = new Map<string, TeaWriteResponse['result']>();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'read_magic_tea_party') {
      const request = (args?.request as { request: Record<string, unknown> }).request;
      if (request.action === 'list') return { version: 1, result: { action: 'list', catalogRevision: 1, rows: [], nextCursor: null } };
      if (request.action === 'session') return { version: 1, result: { action: 'session', catalogRevision: 1, record: request.sessionId === record?.session.id ? record : null } };
      if (request.action === 'messages') return { version: 1, result: { action: 'messages', catalogRevision: 1, sessionId: record!.session.id, instance: record!.instance, revision: record!.revision,
        rows: messages.map((message, index) => ({ ordinal: index + 1, message })), nextCursor: null } };
      if (request.action === 'receipt') {
        const write = request.write as TeaWriteRequest; const operationId = 'operationId' in write.request ? write.request.operationId : '';
        return { version: 1, result: { action: 'receipt', receipt: receipts.has(operationId) ? { operationId, digest: '0'.repeat(64), result: receipts.get(operationId) } : null } };
      }
      throw new Error('unexpected read');
    }
    if (command === 'mutate_magic_tea_party') {
      const write = (args?.request as TeaWriteRequest).request;
      if (fail === write.action) { fail = null; throw { code: 'tea-io', message: 'Local tea storage did not complete; retain the input or unsaved result', writeEvidence: 'not-written' }; }
      if (write.action === 'import') throw new Error('not needed by unit fixture');
      const sessionId = write.action === 'create' ? write.session.id : write.sessionId;
      const instance = write.action === 'create' ? 'b'.repeat(32) : write.instance;
      const revision = write.action === 'create' ? 1 : write.expectedRevision + (write.action === 'delete' ? 0 : 1);
      const result = { action: write.action, sessionId, instance, revision,
        ...('operationId' in write ? { operationId: write.operationId, assistantMessageId: write.assistantMessage.id } : {}) } as TeaWriteResponse['result'];
      if (write.action === 'delete') { record = null; messages = []; }
      else { if (write.action === 'create') messages = []; record = { session: write.session, instance, revision }; }
      if (write.action === 'begin-generation') { if (write.userMessage) messages.push(write.userMessage); messages.push(write.assistantMessage); }
      if (write.action === 'finish-generation') messages = messages.map(message => message.id === write.assistantMessage.id ? write.assistantMessage : message);
      if ('operationId' in write) receipts.set(write.operationId, result);
      if (drop === write.action) { drop = null; throw new Error('synthetic reply loss after commit'); }
      return { version: 1, result };
    }
    if (command === 'stream_target_ai' || command === 'stream_direct_ai') {
      count += 1; const request = args?.request as { requestId: string; contractVersion: 1; mode: 'direct-local' };
      const channel = args?.onEvent as { onmessage: (_event: AiStreamEvent) => void };
      const identity = { requestId: request.requestId, contractVersion: request.contractVersion, mode: request.mode };
      channel.onmessage({ ...identity, sequence: 0, type: 'started' });
      channel.onmessage({ ...identity, sequence: 1, type: 'text-delta', delta: '{"type":"narration","text":"星光😀"}\n' });
      channel.onmessage({ ...identity, sequence: 2, type: 'result', result: { ...identity, status: 'completed', output: { text: '{"type":"narration","text":"星光😀"}\n' }, finishReason: 'stop' } });
      return;
    }
    if (command === 'cancel_direct_ai') return;
    throw new Error('unexpected command');
  });
  const owner = new DesktopTeaSession(createIpcTeaNativePort(invoke), () => `id-${++sequence}`, () => 10);
  return { owner, invoke, get record() { return record; }, get messages() { return messages; }, count: () => count, drop: (action: string) => { drop = action; }, fail: (action: string) => { fail = action; }, options: { invoke, profileId: 'tea-loopback', createChannel: () => ({}) } };
};

describe('text Tea owner save and generation identity', () => {
  it('commits begin before exactly one stream and saves the actual shared parser projection', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('你好');
    await h.owner.start(target, h.options, () => true);
    expect(h.count()).toBe(1); expect(h.owner.getSnapshot().pending).toBe('none');
    expect(h.messages).toHaveLength(2); expect(h.messages[1]).toMatchObject({ status: 'done', content: '星光😀\n', meta: { completion: 'provider' } });
    const calls = h.invoke.mock.calls.map(([command, args]) => command === 'mutate_magic_tea_party' ? (args?.request as TeaWriteRequest).request.action : command);
    expect(calls.indexOf('begin-generation')).toBeLessThan(calls.indexOf('stream_direct_ai'));
    expect(h.owner.isBusy()).toBe(false);
  });
  it('freezes the selected speaker in begin and keeps old identity when the role or user name changes', async () => {
    const h = harness(); await h.owner.select('s');
    const role = { id: 'role', name: '原角色', source: 'local' as const, card: { name: '原角色' } };
    await h.owner.update({ roles: [role], playerRoleId: role.id }); h.owner.setInput('原台词');
    await h.owner.start(target, h.options, () => true);
    await h.owner.update({ roles: [{ ...role, name: '新角色' }], settings: { providerId: 'openai', modelId: 'm', userDisplayName: '新称呼' } });
    expect(h.messages[0]).toMatchObject({ speakerId: 'role', meta: { speakerName: '原角色' } });
    const archive = JSON.parse(await h.owner.export('json'));
    expect(archive.messages[0]).toMatchObject({ speakerId: 'role', meta: { speakerName: '原角色' } });
  });
  it('preflights rejected imports before saving any dirty current draft', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('仍未保存'); h.owner.stageTitle('仍未改名');
    const before = h.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party').length;
    await h.owner.importText(JSON.stringify({ schema: 'magic-tea-party.archive.v1', sessions: [
      { schema: 'magic-tea-party.session.v1', session: baseSession(), roles: [], messages: [] },
      { schema: 'magic-tea-party.session.v1', session: { ...baseSession(), id: 'other' }, roles: [], messages: [], tachieAssets: [{ id: 'media' }] },
    ] }), 'json', () => true);
    expect(h.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party')).toHaveLength(before);
    expect(h.owner.getSnapshot()).toMatchObject({ input: '仍未保存', titleDraft: '仍未改名' });
    expect(h.record?.session.title).toBe('茶会');
  });
  it('does not turn a replacement owner into an unsaved result when an old finish reply arrives', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('旧输入');
    const original = h.invoke.getMockImplementation()!; let release!: () => void;
    h.invoke.mockImplementation(async (command, args) => {
      const result = await original(command, args);
      if (command === 'mutate_magic_tea_party' && (args?.request as TeaWriteRequest).request.action === 'finish-generation') {
        await new Promise<void>(resolve => { release = resolve; });
      }
      return result;
    });
    const running = h.owner.start(target, h.options, () => true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.owner.dispose(); h.owner.activate(); await h.owner.create(); const snapshot = h.owner.getSnapshot();
    release(); await running;
    expect(h.owner.getSnapshot()).toBe(snapshot); expect(snapshot.pending).toBe('none');
  });
  it('saves composer input in the same metadata transaction instead of resetting it on reload', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('尚未发送😀');
    await h.owner.update({ title: '重命名' });
    expect(h.record?.session).toMatchObject({ title: '重命名', draft: '尚未发送😀' });
    expect(h.owner.getSnapshot().input).toBe('尚未发送😀'); expect(h.owner.isBusy()).toBe(false);
  });
  it('releases preparation when the raw user message fails begin admission after a legal prompt clip', async () => {
    const h = harness(); await h.owner.select('s');
    const text = 'x'.repeat(32 * 1024 * 1024); h.owner.setInput(text);
    await h.owner.start(target, h.options, () => true);
    expect(h.count()).toBe(0); expect(h.owner.getSnapshot()).toMatchObject({ busy: false, generating: false, pending: 'none', input: text });
    expect(h.messages).toEqual([]);
    h.owner.setInput('可修正后继续'); await h.owner.start(target, h.options, () => true); expect(h.count()).toBe(1);
  });
  it('does not release or clear a replacement generation when a retired begin reply arrives', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('旧输入');
    const original = h.invoke.getMockImplementation()!;
    let first = true; let releaseBegin!: () => void; let releaseStream!: () => void;
    h.invoke.mockImplementation(async (command, args) => {
      if (command === 'mutate_magic_tea_party' && (args?.request as TeaWriteRequest).request.action === 'begin-generation' && first) {
        first = false; const result = await original(command, args);
        await new Promise<void>(resolve => { releaseBegin = resolve; }); return result;
      }
      if (command === 'stream_direct_ai') await new Promise<void>(resolve => { releaseStream = resolve; });
      return original(command, args);
    });
    const oldRunning = h.owner.start(target, h.options, () => true);
    await vi.waitFor(() => expect(releaseBegin).toBeTypeOf('function'));
    h.owner.dispose(); h.owner.activate(); await h.owner.create(); h.owner.setInput('新输入');
    const running = h.owner.start(target, h.options, () => true);
    await vi.waitFor(() => expect(releaseStream).toBeTypeOf('function'));
    const snapshot = h.owner.getSnapshot();
    releaseBegin(); await oldRunning;
    expect(h.owner.getSnapshot()).toBe(snapshot); expect(snapshot).toMatchObject({ busy: true, generating: true });
    releaseStream(); await running;
    expect(h.count()).toBe(1); expect(h.owner.getSnapshot()).toMatchObject({ busy: false, generating: false });
  });
  it('holds the original owner during unknown begin and continues once only after its receipt is checked', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('原输入'); h.drop('begin-generation');
    const running = h.owner.start(target, h.options, () => true);
    await vi.waitFor(() => expect(h.owner.getSnapshot().pending).toBe('unknown'));
    expect(h.count()).toBe(0); await h.owner.create(); expect(h.record?.session.id).toBe('s');
    await h.owner.resolvePending(); await running;
    expect(h.count()).toBe(1); await h.owner.resolvePending(); expect(h.count()).toBe(1);
  });
  it('resolves a lost finish reply without a second model call or replacing the terminal body on stop', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('原输入'); h.drop('finish-generation');
    const running = h.owner.start(target, h.options, () => true);
    await vi.waitFor(() => expect(h.owner.getSnapshot().pending).toBe('unknown'));
    expect(h.count()).toBe(1); const stored = JSON.stringify(h.messages);
    h.owner.stop(); await h.owner.resolvePending(); await running;
    expect(JSON.stringify(h.messages)).toBe(stored); expect(h.count()).toBe(1); expect(h.owner.isBusy()).toBe(false);
  });
  it('keeps input after failed begin, allows explicit stop and same-body storage retry without model dispatch', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('仍在这里'); h.fail('begin-generation');
    const running = h.owner.start(target, h.options, () => true);
    await vi.waitFor(() => expect(h.owner.getSnapshot().pending).toBe('save'));
    expect(h.owner.getSnapshot().input).toBe('仍在这里'); expect(h.count()).toBe(0);
    h.owner.stop(); await h.owner.retryPending(); await running;
    expect(h.count()).toBe(0); expect(h.messages.at(-1)).toMatchObject({ status: 'error', meta: { completion: 'stopped' } });
  });
  it('preserves raw output-plan extensions while the real choice toggle changes the effective choices switch', async () => {
    const h = harness(); await h.owner.select('s');
    await h.owner.update({ settings: { providerId: 'openai', modelId: 'm', outputPlan: { choices: 'off', summary: 'on', updates: 'on', ...{ future: { inert: 'preserved' } } } } });
    await h.owner.updateSettings({ enableChoices: true });
    expect(h.record?.session.settings.outputPlan).toEqual({ choices: 'auto', summary: 'on', updates: 'on', future: { inert: 'preserved' } });
  });
  it('does not dispatch from a begin receipt after its credential intent changed', async () => {
    const h = harness(); await h.owner.select('s'); h.owner.setInput('原输入'); h.drop('begin-generation');
    let current = true; const running = h.owner.start(target, h.options, () => current);
    await vi.waitFor(() => expect(h.owner.getSnapshot().pending).toBe('unknown'));
    current = false; await h.owner.resolvePending(); await running;
    expect(h.count()).toBe(0); expect(h.messages.at(-1)?.meta).toMatchObject({ completion: 'stopped' });
    const writes = h.invoke.mock.calls.length; h.owner.dispose(); await h.owner.retryPending(); expect(h.invoke.mock.calls).toHaveLength(writes);
  });
  it('rejects a deletion confirmation after metadata revision or instance changed', async () => {
    const h = harness(); await h.owner.select('s');
    const confirmation = h.owner.getSnapshot(); const original = confirmation.record!;
    await h.owner.update({ title: '确认后更新' });
    await h.owner.delete(confirmation.incarnation, 's', original.instance, original.revision);
    expect(h.record?.session.title).toBe('确认后更新');
    await h.owner.delete(h.owner.getSnapshot().incarnation, 's', 'b'.repeat(32), h.record!.revision);
    expect(h.record).not.toBeNull();
    expect(h.invoke.mock.calls.filter(([command, args]) => command === 'mutate_magic_tea_party' && (args?.request as TeaWriteRequest).request.action === 'delete')).toEqual([]);
  });
  it('cannot reuse an old deletion confirmation or late read to affect a replacement owner', async () => {
    const h = harness(); await h.owner.select('s'); const old = h.owner.getSnapshot().incarnation;
    await h.owner.select('s'); await h.owner.delete(old, 's', h.record!.instance, h.record!.revision); expect(h.record).not.toBeNull();
    const read = h.invoke.getMockImplementation()!; let release!: () => void;
    h.invoke.mockImplementation(async (command, args) => { if (command === 'read_magic_tea_party') await new Promise<void>(resolve => { release = resolve; }); return read(command, args); });
    const loading = h.owner.refreshDirectory(); h.owner.dispose(); release(); await loading;
    expect(h.count()).toBe(0);
  });
});

describe('real Native TeaStore and Direct loopback journey', () => {
  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('runs the actual TS owner through Native SQLite, stream_direct_ai, unknown receipts and reopen', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); let sequence = 0;
    const owner = new DesktopTeaSession(createIpcTeaNativePort(probe.invoke), () => `journey-${++sequence}`, () => 100);
    try {
      await owner.create(); const sessionId = owner.getSnapshot().record!.session.id;
      await owner.update({ title: '真实往返', roles: [{ id: 'role', name: '星见', source: 'local', card: { templateId: '通用角色', name: '星见', content: '合成角色' } }] });
      owner.setInput('合成输入'); await probe.control('drop-next-write-reply', { action: 'finish-generation' });
      const running = owner.start(target, probe.aiOptions, () => true);
      await vi.waitFor(() => expect(owner.getSnapshot().pending).toBe('unknown'), { timeout: 5000 });
      await owner.resolvePending(); await running;
      expect(await probe.control('requestCount')).toMatchObject({ count: 1 });
      const exported = await owner.export('json'); expect(JSON.parse(exported).session.title).toBe('真实往返');
      await probe.control('reopen'); await owner.select(sessionId);
      expect(owner.getSnapshot().messages.some(message => message.role === 'assistant' && message.status === 'done')).toBe(true);
      await owner.importText(exported, 'json', () => true);
      const directory = await createIpcTeaNativePort(probe.invoke).read({ version: 1, request: { action: 'list', cursor: null, expectedCatalogRevision: null, limit: 50 } });
      expect((directory as Extract<TeaReadResponse, { version: 1 }>).result.action).toBe('list');
      if (directory.result.action === 'list') expect(directory.result.rows).toHaveLength(2);
      expect(await probe.control('requestCount')).toMatchObject({ count: 1 });
    } finally { owner.dispose(); await probe.close(); }
  }, 20000);
  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('cancels real Direct loopback, freezes the accepted prefix and ignores released late chunks', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); let sequence = 0;
    const owner = new DesktopTeaSession(createIpcTeaNativePort(probe.invoke), () => `stop-${++sequence}`, () => 200);
    try {
      await owner.create(); owner.setInput('停止测试');
      await probe.control('checkpoint', { action: 'model', deferred: true, chunks: ['已接收前缀😀', '不得迟到追加'] });
      const running = owner.start(target, probe.aiOptions, () => true);
      await vi.waitFor(() => expect(owner.getSnapshot().rawUnsaved).toBe('已接收前缀😀'), { timeout: 5000 });
      owner.stop(); await running;
      const saved = JSON.stringify(owner.getSnapshot().messages);
      expect(owner.getSnapshot().messages.at(-1)?.meta).toMatchObject({ completion: 'stopped', rawOutput: '已接收前缀😀' });
      await vi.waitFor(async () => expect(await probe.control('requestCount')).toMatchObject({ count: 1, disconnected: 1 }), { timeout: 5000 });
      await probe.control('checkpoint', { action: 'release' });
      expect(JSON.stringify(owner.getSnapshot().messages)).toBe(saved);
      await owner.create(); expect(owner.getSnapshot().messages).toEqual([]);
      expect(await probe.control('requestCount')).toMatchObject({ count: 1 });
    } finally { owner.dispose(); await probe.close(); }
  }, 20000);
  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('backs up the real Tea tables, deletes and restores without replaying a model', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); let sequence = 0;
    const owner = new DesktopTeaSession(createIpcTeaNativePort(probe.invoke), () => `backup-${++sequence}`, () => 300);
    try {
      await owner.create(); const id = owner.getSnapshot().record!.session.id;
      owner.setInput('可恢复草稿'); await owner.saveDraft();
      const backup = await probe.control('checkpoint', { action: 'backup' }) as { backupId: string };
      expect(typeof backup.backupId).toBe('string');
      await owner.delete(owner.getSnapshot().incarnation, id, owner.getSnapshot().record!.instance, owner.getSnapshot().record!.revision); expect(owner.getSnapshot().record).toBeNull();
      await probe.control('checkpoint', { action: 'prepare-restore', backupId: backup.backupId });
      await probe.control('reopen'); await owner.select(id);
      expect(owner.getSnapshot().input).toBe('可恢复草稿');
      expect(await probe.control('requestCount')).toMatchObject({ count: 0 });
    } finally { owner.dispose(); await probe.close(); }
  }, 20000);

});
