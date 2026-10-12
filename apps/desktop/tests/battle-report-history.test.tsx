// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/battle-report-history.json';
import { DesktopBattleReportRequestSchema } from '@mahoshojo/contracts/battle-report-history';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn(), userId: 42 as number | null, epoch: 0 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => {
  const state = () => ({ account: mocks.userId === null ? null : { userId: mocks.userId, username: `user${mocks.userId}`, displayName: null }, verification: 'verified' });
  const store = { getSnapshot: state, getCredentialEpoch: () => mocks.epoch, refresh: mocks.refresh };
  return { useDesktopCloudSession: () => ({ state: state(), store }) };
});
vi.mock('../src/features/account/AccountPanel', () => ({ AccountPanel: () => null }));
vi.mock('../src/features/account/ProfileSignaturePanel', () => ({ ProfileSignaturePanel: () => null }));
vi.mock('../src/features/account/use-topbar-avatar', () => ({ useTopbarAvatar: () => null }));
import { DesktopMe } from '../src/app/me-page';
import { readCloudBattleReports } from '../src/platform/battle-report-bridge';
let root: Root; let container: HTMLDivElement;
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const data = (userId = mocks.userId!, title = `账号${userId}战报`) => ({ userId, data: { ...fixture.list, viewerUserId: userId, records: [{ ...fixture.list.records[0], displayTitle: title }] } });
const render = () => act(async () => root.render(<DesktopMe />));
const button = (text: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === text)!;
const click = (text: string) => act(async () => button(text).click());
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.userId = 42; mocks.epoch = 0; mocks.refresh.mockReset(); mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (_command, { request }) => request.kind === 'detail'
    ? { userId: request.expectedUserId, data: { ...fixture.detail, viewerUserId: request.expectedUserId } }
    : { ...data(request.expectedUserId), data: { ...data(request.expectedUserId).data, page: request.filters.page, pageSize: request.filters.pageSize } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('Desktop actual me report history', () => {
  it('has no signed-out read and invokes only the fixed read command for shared list/detail', async () => {
    mocks.userId = null; await render(); expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.userId = 42; await render(); expect(container.textContent).toContain('账号42战报'); expect(container.textContent).not.toContain('重生战报');
    expect(mocks.invoke).toHaveBeenCalledWith('cloud_battle_reports_read', { request: fixture.listRequest });
    await click('详情'); expect(mocks.invoke).toHaveBeenLastCalledWith('cloud_battle_reports_read', { request: fixture.detailRequest });
    expect(document.querySelector('pre')?.textContent?.trim()).toBe(fixture.detail.record.outputPreview);
    expect(document.body.textContent).not.toContain('重生战报'); expect(document.querySelector('script')).toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); await click('刷新'); expect(mocks.invoke.mock.calls).toHaveLength(3);
  });
  it.each(['success', '401'])('hides and fences late %s through account switch and same-account relogin', async (kind) => {
    await render(); const old = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(old.promise); await click('详情');
    mocks.epoch++; await render(); expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { if (kind === '401') old.reject({ code: 'not-authenticated', message: 'old401' }); else old.resolve({ userId: 42, data: fixture.detail }); });
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('原始正文'); expect(document.body.textContent).not.toContain('old401');
    mocks.userId = 43; mocks.epoch++; await render(); expect(container.textContent).toContain('账号43战报'); expect(container.textContent).not.toContain('账号42战报');
    mocks.userId = null; mocks.epoch++; await render(); expect(container.textContent).not.toContain('账号43战报');
  });
  it('ignores stale list responses after filter changes and closes/reopens details without replay', async () => {
    const old = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(old.promise); await render();
    const mode = container.querySelectorAll('select')[2]!;
    await act(async () => { mode.value = 'daily'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(mocks.invoke.mock.lastCall?.[1].request.filters).toMatchObject({ mode: 'daily', page: 1 });
    await act(async () => old.resolve(data(42, '迟到旧列表'))); expect(container.textContent).not.toContain('迟到旧列表');
    const first = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(first.promise); await click('详情'); await click('关闭'); await click('详情');
    await act(async () => first.resolve({ userId: 42, data: { ...fixture.detail, record: { ...fixture.detail.record, outputPreview: '旧详情' } } }));
    expect(document.body.textContent).not.toContain('旧详情'); expect(document.body.textContent).toContain('原始正文');
  });
  it.each([['forbidden', '无权查看'], ['not-found', '记录不存在'], ['response-too-large', '本次详情过大，未加载'], ['network-error', '网络不可用']])('keeps %s errors distinct from true empty history', async (code, message) => {
    mocks.invoke.mockRejectedValue({ code, message }); await render(); expect(container.textContent).toContain(message); expect(container.textContent).not.toContain('暂无战报记录');
    mocks.invoke.mockResolvedValue({ userId: 42, data: { ...fixture.list, total: 0, records: [] } }); await click('刷新'); expect(container.textContent).toContain('暂无战报记录');
  });
  it('keeps legacy opaque IDs listed and explains unsupported details without invoking Native', async () => {
    mocks.invoke.mockResolvedValue({ userId: 42, data: { ...fixture.list, records: [{ ...fixture.list.records[0], id: '旧编号:opaque', displayTitle: '旧历史仍可见' }] } });
    await render(); expect(container.textContent).toContain('旧历史仍可见');
    await click('详情');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('此历史编号暂不支持桌面端打开，请在网页版查看');
    expect(container.textContent).not.toContain('暂无战报记录');
    expect(document.body.textContent).not.toContain('记录不存在');
  });
  it.skipIf(!process.env.BATTLE_REPORT_NATIVE_WIRE_INPUT)('consumes real Native loopback Serialize bytes through the bridge and actual Desktop owner/member/blocked views', async () => {
    const native = (name: string): unknown => JSON.parse(readFileSync(join(process.env.BATTLE_REPORT_NATIVE_WIRE_INPUT!, `${name}.json`), 'utf8'));
    const list = native('list');
    let detail = native('detail');
    mocks.invoke.mockImplementation(async (command, { request }) => {
      expect(command).toBe('cloud_battle_reports_read');
      return request.kind === 'list' ? list : detail;
    });
    const request = DesktopBattleReportRequestSchema.parse(fixture.detailRequest);
    if (request.kind !== 'detail') throw new Error('fixture');
    await render(); expect(container.textContent).toContain('演示战报');
    for (const name of ['detail', 'member', 'blocked']) {
      detail = native(name);
      const parsed = await readCloudBattleReports(mocks.invoke, request);
      expect(parsed.viewerUserId).toBe(42);
      expect(parsed.combatants[0]?.name).toBe('角色甲');
      if (name === 'detail') expect(parsed.combatants[0]?.characterGuidance).toBe('本人指导');
      else for (const key of ['templateId', 'isNative', 'isPreset', 'characterGuidance', 'dataCardId', 'dataCardUpdatedAt']) expect(parsed.combatants[0]).not.toHaveProperty(key);
      await click('详情');
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('角色甲');
      if (name === 'blocked') {
        expect(parsed.record.outputPreview).toBeNull();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已屏蔽');
        expect(document.querySelector('pre')).toBeNull();
      } else expect(document.querySelector('pre')?.textContent?.trim()).toBe(parsed.record.outputPreview);
      if (name !== 'detail') expect(document.querySelector('[role="dialog"]')?.textContent).toContain('多人 · 成员');
      expect(document.querySelector('script')).toBeNull();
      await click('关闭');
    }
  });
  it('only current 401 requests session convergence', async () => {
    mocks.invoke.mockRejectedValue({ code: 'not-authenticated', message: '登录已失效' }); await render(); expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Desktop typed report bridge', () => {
  it('checks request shape before invocation and verifies response owner and target', async () => {
    const valid = DesktopBattleReportRequestSchema.parse(fixture.detailRequest);
    if (valid.kind !== 'detail') throw new Error('fixture');
    await expect(readCloudBattleReports(mocks.invoke, { ...valid, generationId: '../escape' })).rejects.toMatchObject({ code: 'invalid-request' }); expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValue({ userId: 43, data: fixture.detail }); await expect(readCloudBattleReports(mocks.invoke, valid)).rejects.toMatchObject({ code: 'invalid-response' });
    mocks.invoke.mockResolvedValue({ userId: 42, data: { ...fixture.detail, record: { ...fixture.detail.record, id: 'wrong' } } }); await expect(readCloudBattleReports(mocks.invoke, valid)).rejects.toMatchObject({ code: 'invalid-response' });
    mocks.invoke.mockResolvedValue({ userId: 42, data: fixture.detail, cookie: 'unexpected' }); await expect(readCloudBattleReports(mocks.invoke, valid)).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
