// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMagicTeaPartySessions, type UseMagicTeaPartySessionsResult } from '@/lib/magic-tea-party/useMagicTeaPartySessions';
import type { MagicTeaPartySession } from '@/lib/magic-tea-party/types';

const host = vi.hoisted(() => ({ preserve: vi.fn(), read: vi.fn(), list: vi.fn(), messages: vi.fn(), put: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/magic-tea-party/migration', () => ({ migrateMagicTeaPartyLocalStorage: vi.fn() }));
vi.mock('@/lib/magic-tea-party/storage', async () => ({ ...(await vi.importActual('@/lib/magic-tea-party/storage')),
  putMagicTeaPartySessionPreservingRoles: host.preserve, getMagicTeaPartySession: host.read,
  listMagicTeaPartySessions: host.list, listMagicTeaPartyMessages: host.messages, putMagicTeaPartySession: host.put,
}));
let root: Root;
let container: HTMLDivElement;
let state: UseMagicTeaPartySessionsResult;
let original: MagicTeaPartySession;
let stored: Map<string, MagicTeaPartySession>;
function Harness() {
  const current = useMagicTeaPartySessions({ userProviderConfig: null, onGlobalError: host.error });
  useEffect(() => { state = current; });
  return null;
}

beforeEach(async () => {
  for (const mock of Object.values(host)) mock.mockReset();
  window.localStorage.clear();
  original = { id: 'tea', title: '原会话', createdAt: 1, updatedAt: 2,
    roles: [{ id: 'role', name: '原角色', source: 'local', card: { content: '原文' } }],
    scenario: { id: 'scene', title: '手工主情景', source: 'local', card: { content: '旧场景' } },
    auxScenarios: [{ id: 'aux', title: '手工辅助情景', source: 'local', card: { content: '旧辅助场景' } }],
    draft: '尚未发送的输入', summary: '原摘要',
    settings: { providerId: 'openai', modelId: 'test', outputFormat: 'markdown', enableChoices: false, choiceCount: 7, autoSummaryEnabled: true, outputPlan: { choices: 'off', summary: 'on', updates: 'auto' } } };
  stored = new Map([[original.id, original]]);
  host.list.mockImplementation(async () => [...stored.values()]);
  host.read.mockImplementation(async (id: string) => stored.get(id) ?? null);
  host.messages.mockResolvedValue([]);
  host.put.mockImplementation(async (session: MagicTeaPartySession) => { stored.set(session.id, session); });
  host.preserve.mockImplementation(async (session: MagicTeaPartySession) => { stored.set(session.id, session); return session; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(state.activeSession?.id).toBe(original.id);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('commits settings and scenarios together exactly once, preserving roles, history, input and summary', async () => {
  const messages = [{ id: 'm', sessionId: 'tea', role: 'user' as const, content: '原始聊天历史', createdAt: 3 }];
  await act(async () => state.setMessages(messages));
  await act(async () => state.applyPreset('arena-daily'));
  expect(host.preserve).toHaveBeenCalledOnce();
  const next = stored.get('tea')!;
  expect(next.settings).toMatchObject({ presetId: 'arena-daily', worldbookPresetId: 'arena-core', outputFormat: 'jsonl', enableChoices: true, choiceCount: 4, autoSummaryEnabled: true, outputPlan: { choices: 'auto', summary: 'on', updates: 'auto' } });
  expect(next.scenario).toMatchObject({ id: 'preset-scenario', source: 'preset', presetId: 'arena-daily' });
  expect(next.auxScenarios).toEqual([]);
  for (const key of ['roles', 'draft', 'summary', 'title', 'createdAt'] as const) expect(next[key]).toEqual(original[key]);
  expect(state.messages).toBe(messages);
  expect(state.preferences).toMatchObject({ lastPresetId: 'arena-daily', lastWorldbookPresetId: 'arena-core', choiceCount: 4 });
  expect(state.activeSession).toMatchObject({ settings: next.settings, scenario: next.scenario, auxScenarios: [] });
  expect(host.error).not.toHaveBeenCalled();
});

it('cancels the same preset with one write and leaves output choices unchanged', async () => {
  await act(async () => state.applyPreset('arena-classic'));
  host.preserve.mockClear();
  await act(async () => state.applyPreset('arena-classic'));
  expect(host.preserve).toHaveBeenCalledOnce();
  expect(stored.get('tea')).toMatchObject({ scenario: undefined, auxScenarios: [],
    settings: { presetId: undefined, worldbookPresetId: undefined, outputFormat: 'jsonl', enableChoices: true, choiceCount: 3, outputPlan: { choices: 'auto', summary: 'on', updates: 'auto' } } });
  expect(state.preferences.lastPresetId).toBeUndefined(); expect(state.preferences.lastWorldbookPresetId).toBeUndefined();
  expect(state.activeSession?.roles).toEqual(original.roles);
});

it('creates plain tea for explicit null even when the last preset is selected, while undefined still reuses it', async () => {
  await act(async () => state.applyPreferencePatch({ lastPresetId: 'arena-kizuna', outputPlan: { choices: 'off', summary: 'on', updates: 'off' } }));
  await act(async () => state.createSession(null));
  expect(host.put).toHaveBeenCalledOnce();
  const plain = host.put.mock.calls[0][0] as MagicTeaPartySession;
  expect(plain.settings.outputPlan).toEqual({ choices: 'off', summary: 'on', updates: 'off' });
  expect(plain.settings.presetId).toBeUndefined(); expect(plain.settings.worldbookPresetId).toBeUndefined(); expect(plain.scenario).toBeUndefined();
  await act(async () => state.createSession());
  const preset = host.put.mock.calls[1][0] as MagicTeaPartySession;
  expect(preset.settings).toMatchObject({ presetId: 'arena-kizuna', worldbookPresetId: 'arena-core', outputPlan: { choices: 'auto', summary: 'on', updates: 'off' } });
  expect(preset.scenario).toMatchObject({ presetId: 'arena-kizuna', source: 'preset' });
  expect(preset.auxScenarios).toEqual([]);
});
