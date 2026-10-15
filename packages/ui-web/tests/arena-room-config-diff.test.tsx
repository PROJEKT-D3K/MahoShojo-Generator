// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import type { ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import { buildArenaRoomConfigDiffEntries, collectArenaRoomConfigDiffReferenceRequests, RoomConfigDiffView } from '../src/arena-room';
let root: Root, container: HTMLDivElement;
const base = fixture.operations.create.success.result.snapshot.sharedConfig as ArenaRoomSharedConfig;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('renders the shared semantic diff with escaped labels, exact reference identity and no network', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const local = { ...base, userGuidance: '<img src=x onerror=alert(1)>', selectedLanguage: 'en-US', scenario: { key: 'data-card:scene', ref: { kind: 'scenario' as const, id: 'scene', versionToken: 'v9' } } };
  const resolveName = vi.fn(() => '场景标题');
  const entries = buildArenaRoomConfigDiffEntries(base, local, resolveName, code => code === 'en-US' ? '英语' : '简体中文');
  expect(collectArenaRoomConfigDiffReferenceRequests([local])).toContainEqual({ source: 'data-card', kind: 'scenario', id: 'scene', versionToken: 'v9' });
  expect(resolveName).toHaveBeenCalledWith({ source: 'data-card', kind: 'scenario', id: 'scene', versionToken: 'v9' });
  await act(async () => root.render(<RoomConfigDiffView roomConfig={base} localConfig={local} revision={8} entries={entries} emptyMessage="一致" />));
  expect(container.textContent).toContain('英语'); expect(container.textContent).toContain('场景标题');
  expect(container.querySelector('img')).toBeNull(); expect(container.querySelector('button')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it('does not claim equality when the local projection is unavailable', async () => {
  await act(async () => root.render(<RoomConfigDiffView roomConfig={base} localConfig={null} revision={8} entries={[]} emptyMessage="配置一致" />));
  expect(container.textContent).toContain('无法转换'); expect(container.textContent).not.toContain('配置一致');
});
it('uses the host equality explanation without implying local body equality', async () => {
  await act(async () => root.render(<RoomConfigDiffView roomConfig={base} localConfig={base} revision={8} entries={buildArenaRoomConfigDiffEntries(base, base, () => undefined)} emptyMessage="可共享设置一致；本地正文不参与比较" />));
  expect(container.textContent).toContain('本地正文不参与比较');
});
