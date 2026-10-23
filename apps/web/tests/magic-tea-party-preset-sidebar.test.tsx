// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MagicTeaPartySessionSidebar } from '@/components/magic-tea-party/SessionSidebar';
import { DEFAULT_MAGIC_TEA_PARTY_PREFERENCES } from '@/lib/magic-tea-party/preferences';
import type { MagicTeaPartySession } from '@/lib/magic-tea-party/types';

vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/magic-tea-party/BranchChainModal', () => ({ MagicTeaPartyBranchChainModal: () => null }));
vi.mock('@/components/magic-tea-party/SessionCleanupPanel', () => ({ MagicTeaPartySessionCleanupPanel: () => null }));
vi.mock('@/components/magic-tea-party/GlobalSettingsPanel', () => ({ MagicTeaPartyGlobalSettingsPanel: () => null }));
vi.mock('@/components/magic-tea-party/ImportExportPanel', () => ({ MagicTeaPartyImportExportPanel: () => null }));
const session: MagicTeaPartySession = { id: 'tea', title: '茶会', createdAt: 1, updatedAt: 1, roles: [], settings: { providerId: 'test', modelId: 'test', presetId: 'arena-classic' } };
let root: Root;
let container: HTMLDivElement;
const apply = vi.fn(), create = vi.fn();
const noop = () => {};
const render = async (activeSession: MagicTeaPartySession | null = session) => act(async () => root.render(
  <MagicTeaPartySessionSidebar activeSession={activeSession} activeSessionId={activeSession?.id ?? null} sessions={activeSession ? [activeSession] : []}
    preferences={DEFAULT_MAGIC_TEA_PARTY_PREFERENCES} onCreateSession={create} onPresetSelected={apply}
    onSelectSession={noop} onDeleteSession={noop} onToggleSessionPin={noop} onReorderPinnedSessions={noop} onSessionImported={noop}
    onProviderConfigChange={noop} onPreferenceChange={noop} onSessionSettingChange={noop} onMergeSession={noop} onCleanupSessions={async () => {}} />
));
const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!;
const choose = async (title: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')].find(node => node.textContent?.startsWith(title))!.click());
beforeEach(() => { apply.mockReset(); create.mockReset(); window.localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('previews the shared changes and only calls the Web owner after confirmation; cancellation performs no write', async () => {
  await render(); await choose('日常互动');
  expect(apply).not.toHaveBeenCalled(); expect(container.textContent).toContain('清空所有辅助情景');
  await act(async () => button('返回，不更改').click()); expect(apply).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="预设变更预览"]')).toBeNull();
  await choose('日常互动'); await act(async () => button('确认应用预设').click());
  expect(apply).toHaveBeenCalledExactlyOnceWith('arena-daily');
  expect(container.querySelector('[aria-label="预设变更预览"]')).toBeNull();
});

it('still allows same-preset cancellation and explicit plain/new-preset creation', async () => {
  await render(); await choose('经典战报');
  expect(container.textContent).toContain('输出格式和行动选项设置保持不变');
  await act(async () => button('确认取消预设').click()); expect(apply).toHaveBeenCalledExactlyOnceWith('arena-classic');
  await act(async () => button('新建普通茶会').click()); expect(create).toHaveBeenLastCalledWith(null);
  await act(async () => button('新建羁绊战报').click()); expect(create).toHaveBeenLastCalledWith('arena-kizuna');
});

it('invalidates stale confirmation after any session change, even switching away and back to the same object', async () => {
  await render(); await choose('日常互动');
  await render({ ...session, id: 'other' }); expect(container.querySelector('[aria-label="预设变更预览"]')).toBeNull();
  await render(); expect(container.querySelector('[aria-label="预设变更预览"]')).toBeNull(); expect(apply).not.toHaveBeenCalled();
  await choose('日常互动'); await render({ ...session, updatedAt: 2 });
  expect(container.querySelector('[aria-label="预设变更预览"]')).toBeNull(); expect(apply).not.toHaveBeenCalled();
});
