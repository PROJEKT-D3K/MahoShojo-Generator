// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MagicTeaPartySessionSetupPanel } from '@mahoshojo/ui-web/magic-tea-party';
import { buildMagicTeaPartyMainPrompt } from '@mahoshojo/ai-core/magic-tea-party';
import { useMagicTeaPartySessions, type UseMagicTeaPartySessionsResult } from '@/lib/magic-tea-party/useMagicTeaPartySessions';
import { useMagicTeaPartyChat, type UseMagicTeaPartyChatResult } from '@/lib/magic-tea-party/useMagicTeaPartyChat';
import { deleteMagicTeaPartySession, getMagicTeaPartySession, listMagicTeaPartyMessages,
  putMagicTeaPartyMessage, putMagicTeaPartySession } from '@/lib/magic-tea-party/storage';
import type { MagicTeaPartyMessage, MagicTeaPartySession } from '@/lib/magic-tea-party/types';

const host = vi.hoisted(() => ({ dispatch: vi.fn(), safety: vi.fn(), error: vi.fn(), navigate: vi.fn() }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: host.navigate }) }));
vi.mock('@/lib/magic-tea-party/migration', () => ({ migrateMagicTeaPartyLocalStorage: vi.fn() }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: host.dispatch }) }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({}) } }));
vi.mock('@/lib/content-safety/client', () => ({ getSensitiveWordRedirectTarget: host.safety }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false }) }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: (text: string) => ({ filteredText: text }) }));
// Owners, shared panel/prompt, stream reader, and IndexedDB transactions are real.
const provider = { providerId: 'openai', modelId: 'test', apiKey: 'test-key' };
let state: UseMagicTeaPartySessionsResult;
let chat: UseMagicTeaPartyChatResult;
let root: Root;
let container: HTMLDivElement;
let session: MagicTeaPartySession;
let historical: MagicTeaPartyMessage;
let extraIds: string[];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
function Harness() {
  const current = useMagicTeaPartySessions({ userProviderConfig: provider, onGlobalError: host.error });
  const currentChat = useMagicTeaPartyChat({ activeSession: current.activeSession, activeSessionId: current.activeSessionId,
    messages: current.messages, setMessages: current.setMessages, persistSession: current.persistSession,
    preferences: current.preferences, userProviderConfig: provider, onGlobalError: host.error, router: { push: host.navigate } });
  useEffect(() => { state = current; chat = currentChat; }, [current, currentChat]);
  return <MagicTeaPartySessionSetupPanel activeSession={current.activeSession} playerOptions={current.playerOptions}
    onOpenRoleModal={() => {}} onOpenScenarioModal={() => {}} onUploadRoles={() => {}} onUploadScenarios={() => {}}
    onUpdateRoles={current.updateActiveSessionRoles} onUpdateScenarios={current.updateActiveSessionScenarios}
    onUpdatePlayerRole={current.updatePlayerRole} onUpdateTitle={current.updateSessionTitle} onLockTitle={current.lockSessionTitle}
    onImportRolesText={() => {}} onImportScenariosText={() => {}} onDropRoles={() => {}} onDropScenarios={() => {}} />;
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) await act(tick);
  expect(check()).toBe(true);
}
const selection = () => container.querySelector('select')!;
async function select(value: string) {
  await act(async () => {
    selection().value = value; selection().dispatchEvent(new Event('change', { bubbles: true }));
    await tick(); await getMagicTeaPartySession(session.id);
  });
  await waitFor(() => state.activeSession?.playerRoleId === (value || null));
}
async function assertIdentity(id: string | null, roleIds: string[]) {
  for (const copy of [await getMagicTeaPartySession(session.id), state.activeSession, state.sessions.find(item => item.id === session.id)]) {
    expect(copy?.roles.map(role => role.id)).toEqual(roleIds); expect(copy?.playerRoleId).toBe(id);
  }
  expect(selection().value).toBe(id ?? '');
}
const response = () => new Response('event: text\ndata: {"text":"茶会继续。"}\n\nevent: tea_completion\ndata: {"finishReason":"stop"}\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } });
const request = () => JSON.parse(host.dispatch.mock.calls.at(-1)![1].body);
const prompt = (body: ReturnType<typeof request>) => buildMagicTeaPartyMainPrompt({
  session: { playerRoleId: body.playerRoleId, settings: body.settings }, roles: body.roles, messages: body.messages });
async function send(text = '新的发言') {
  await act(async () => { expect(await chat.sendMessage(text)).toBe(true); });
  const saved = (await listMagicTeaPartyMessages(session.id)).find(message => message.role === 'user' && message.content === text)!;
  expect(saved).toBeDefined(); const body = request();
  return { saved, body, prompt: prompt(body) };
}
beforeEach(async () => {
  vi.clearAllMocks(); window.localStorage.clear(); extraIds = [];
  host.safety.mockResolvedValue(null); host.dispatch.mockImplementation(async () => response());
  session = { id: crypto.randomUUID(), title: '身份茶会', createdAt: 1, updatedAt: 1, playerRoleId: 'a',
    roles: [{ id: 'a', name: '角色 A', source: 'local', card: { name: '角色 A' } },
      { id: 'b', name: '角色 B', source: 'local', card: { name: '角色 B' } }],
    settings: { providerId: 'openai', modelId: 'test', userDisplayName: '来客', outputFormat: 'markdown',
      enableChoices: false, enableSummary: false, writeArenaHistory: false, writeCurrentState: false,
      outputPlan: { choices: 'off', summary: 'off', updates: 'off' } } };
  historical = { id: crypto.randomUUID(), sessionId: session.id, role: 'user', content: '旧发言', createdAt: 2,
    speakerId: 'a', meta: { speakerName: '历史名字 A' }, status: 'done' };
  await putMagicTeaPartySession(session); await putMagicTeaPartyMessage(historical);
  window.localStorage.setItem('magic-tea-party:recent-session', session.id);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await waitFor(() => state.activeSession?.id === session.id && state.messages.length === 1);
});
afterEach(async () => {
  vi.restoreAllMocks(); await act(async () => root.unmount()); container.remove();
  await deleteMagicTeaPartySession(session.id); for (const id of extraIds) await deleteMagicTeaPartySession(id);
});

describe('Web current player identity across real owners and shared UI', () => {
  it('clears a removed player atomically, permits reselection, and preserves historical speaker identity', async () => {
    const remove = [...container.querySelectorAll('button')].find(button => button.textContent === '×')!;
    await act(async () => { remove.click(); await tick(); await getMagicTeaPartySession(session.id); });
    await waitFor(() => state.activeSession?.roles.length === 1); await assertIdentity(null, ['b']);
    const unassigned = await send();
    expect(unassigned.saved.speakerId).toBeUndefined(); expect(unassigned.saved.meta?.speakerName).toBe('来客');
    expect(unassigned.body.playerRoleId).toBeNull(); expect(unassigned.prompt).toContain('玩家身份：来客');
    await select('b'); await assertIdentity('b', ['b']);
    const selected = await send('重选后的发言');
    expect(selected.saved).toMatchObject({ speakerId: 'b', meta: { speakerName: '角色 B' } });
    expect(selected.prompt).toContain('玩家正在扮演角色：角色 B');
    expect((await listMagicTeaPartyMessages(session.id)).find(message => message.id === historical.id)).toEqual(historical);
  });
  it('keeps a surviving selection but clears it when the participant list becomes empty', async () => {
    await act(async () => state.updateActiveSessionRoles([session.roles[0]])); await assertIdentity('a', ['a']);
    await act(async () => state.updateActiveSessionRoles([])); await assertIdentity(null, []);
    const result = await send(); expect(result.saved.speakerId).toBeUndefined(); expect(result.prompt).toContain('玩家身份：来客');
  });
  it.each([false, true])('projects a restored orphan without a read-time migration and sends no orphan identity (empty=%s)', async empty => {
    await putMagicTeaPartySession({ ...session, roles: empty ? [] : [session.roles[1]], playerRoleId: 'deleted' });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await waitFor(() => state.activeSession?.id === session.id && state.messages.length === 1);
    expect((await getMagicTeaPartySession(session.id))?.playerRoleId).toBe('deleted'); expect(selection().value).toBe('');
    const result = await send(); expect(result.saved.speakerId).toBeUndefined();
    expect(result.saved.meta?.speakerName).toBe('来客'); expect(result.body.playerRoleId).toBeNull();
    expect(result.prompt).toContain('玩家身份：来客'); expect(result.prompt).not.toContain('玩家正在扮演角色');
  });
  it.each([false, true])('keeps the send snapshot during pending preflight without restoring a previous player (remove=%s)', async remove => {
    const safety = deferred<null>(); host.safety.mockReturnValueOnce(safety.promise);
    let pending!: Promise<boolean>;
    await act(async () => { pending = chat.sendMessage('在途发言'); });
    if (remove) await act(async () => state.updateActiveSessionRoles([session.roles[1]]));
    await select('b');
    await act(async () => { safety.resolve(null); expect(await pending).toBe(true); });
    const saved = (await listMagicTeaPartyMessages(session.id)).find(message => message.content === '在途发言')!;
    expect(saved).toMatchObject({ speakerId: 'a', meta: { speakerName: '角色 A' } });
    const body = request(); expect(body.playerRoleId).toBe('a');
    expect(body.roles.map((role: { id: string }) => role.id)).toEqual(['a', 'b']); expect(prompt(body)).toContain('玩家正在扮演角色：角色 A');
    await assertIdentity('b', remove ? ['b'] : ['a', 'b']);
    const next = await send('下一轮'); expect(next.saved.speakerId).toBe('b'); expect(next.body.playerRoleId).toBe('b');
  });
  it('does not half-save roles or player selection when the role-list transaction aborts', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      if (this.name === 'sessions' && value.id === session.id && value.roles.length === 0)
        request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await act(async () => { await expect(state.updateActiveSessionRoles([])).rejects.toBeDefined(); });
    await assertIdentity('a', ['a', 'b']);
  });
  it('adopts roles and player selection together only after the transaction completes', async () => {
    const written = deferred<void>(); let release = false;
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      if (this.name === 'sessions' && value.id === session.id && value.roles.length === 0) {
        request.addEventListener('success', () => {
          const hold = () => { const read = this.get(session.id); read.addEventListener('success', () => { if (!release) hold(); }); };
          hold(); written.resolve();
        });
      }
      return request;
    });
    let pending!: Promise<void>;
    try {
      await act(async () => { pending = state.updateActiveSessionRoles([]); await written.promise; });
      expect(state.activeSession?.roles).toEqual(session.roles); expect(state.activeSession?.playerRoleId).toBe('a');
      expect(state.sessions.find(item => item.id === session.id)?.playerRoleId).toBe('a'); expect(selection().value).toBe('a');
    } finally { await act(async () => { release = true; await pending; }); }
    await assertIdentity(null, []);
  });
  it('does not optimistically replace player selection when its transaction fails', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      if (this.name === 'sessions' && value.id === session.id && value.playerRoleId === 'b')
        request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await act(async () => { state.updatePlayerRole('b'); await tick(); });
    await waitFor(() => host.error.mock.calls.some(([error]) => Boolean(error)));
    await assertIdentity('a', ['a', 'b']);
  });
  it('uses the resolved request display name for both stored message and prompt', async () => {
    await act(async () => state.updateActiveSessionSettings({ userDisplayName: ' ' }));
    await select('');
    await act(async () => state.applyPreferencePatch({ userDisplayName: '偏好名字' }));
    expect(selection().selectedOptions[0].textContent).toBe('{{user}}（偏好名字）');
    const result = await send(); expect(result.saved.meta?.speakerName).toBe('偏好名字');
    expect(result.body.settings.userDisplayName).toBe('偏好名字'); expect(result.prompt).toContain('玩家身份：偏好名字');
  });
  it('safely projects a malformed display name restored from old storage', async () => {
    await putMagicTeaPartySession({ ...session, playerRoleId: null,
      settings: { ...session.settings, userDisplayName: 123 as unknown as string } });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await waitFor(() => state.activeSession?.id === session.id && state.messages.length === 1);
    const result = await send(); expect(result.saved.meta?.speakerName).toBe('旅人');
    expect(result.prompt).toContain('玩家身份：旅人');
  });
  it.each(['session', 'preference'])('uses the same request-safe name at a UTF-16 boundary (%s)', async source => {
    const longName = '甲'.repeat(19) + '😀尾';
    await act(async () => state.updateActiveSessionSettings({ userDisplayName: source === 'session' ? longName : undefined }));
    if (source === 'preference') await act(async () => state.applyPreferencePatch({ userDisplayName: longName }));
    await select(''); const result = await send();
    expect(result.saved.meta?.speakerName).toBe('甲'.repeat(19));
    expect(result.body.settings.userDisplayName).toBe(result.saved.meta?.speakerName);
    expect(selection().selectedOptions[0].textContent).toBe(`{{user}}（${'甲'.repeat(19)}）`);
  });
  it.each([undefined, ' '])('keeps edited branch message and continuation prompt on the same fallback name (%j)', async userDisplayName => {
    await act(async () => state.updateActiveSessionSettings({ userDisplayName }));
    await select(''); await act(async () => state.applyPreferencePatch({ userDisplayName: '分支来客' }));
    let id!: string | null;
    await act(async () => { id = await state.forkSessionFromMessage(historical.id, '用新身份继续'); });
    expect(id).not.toBeNull(); extraIds.push(id!);
    await waitFor(() => state.activeSession?.id === id && state.messages.some(message => message.revisionOf === historical.id));
    const edited = (await listMagicTeaPartyMessages(id!)).find(message => message.revisionOf === historical.id)!;
    expect(edited.speakerId).toBeUndefined(); expect(edited.meta?.speakerName).toBe('分支来客');
    await act(async () => chat.continueGeneration());
    expect(request().settings.userDisplayName).toBe('分支来客'); expect(prompt(request())).toContain('玩家身份：分支来客');
  });
  it('assigns an edited new branch message effective identity while historical messages stay intact', async () => {
    await putMagicTeaPartySession({ ...session, roles: [], playerRoleId: 'deleted' });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await waitFor(() => state.activeSession?.id === session.id && state.messages.length === 1);
    let id!: string | null;
    await act(async () => { id = await state.forkSessionFromMessage(historical.id, '分支新发言'); });
    expect(id).not.toBeNull(); extraIds.push(id!);
    await waitFor(() => state.activeSession?.id === id && state.messages.some(message => message.revisionOf === historical.id));
    expect((await getMagicTeaPartySession(id!))?.playerRoleId).toBeNull();
    const edited = (await listMagicTeaPartyMessages(id!)).find(message => message.revisionOf === historical.id)!;
    expect(edited.speakerId).toBeUndefined(); expect(edited.meta?.speakerName).toBe('来客');
    expect((await listMagicTeaPartyMessages(session.id)).find(message => message.id === historical.id)).toEqual(historical);
  });
});
