// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RecycleBinModal from '@/components/CharManager/RecycleBinModal';
import { authStorage } from '@/lib/auth';
import { captureAuthIdentity } from '@/lib/auth-identity';
const session = vi.hoisted(() => ({ id: 7, epoch: 0 }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: { id: session.id }, identityEpoch: session.epoch }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const row = { id: 'c', name: '云端回收原件', description: '', type: 'character', is_public: 1, review_status: 'approved', created_at: null, updated_at: null, deleted_at: '2026-10-15T00:00:00Z', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false };
let root: Root; let container: HTMLDivElement; const fetcher = vi.fn();
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; session.id = 7; session.epoch = captureAuthIdentity().epoch;
  vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ userId: 7, username: 'owner' });
  vi.spyOn(authStorage, 'getAuthHeader').mockRejectedValue(new Error('只读入口不能bootstrap'));
  fetcher.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith('/api/data-cards/recycle-owned/detail?')) return Response.json({ success: true, accountFenceVersion: 1, ownerUserId: 7, card: { ...row, data: '{"templateId":"通用角色","name":"原件","content":"墓碑正文"}' } });
    if (url.startsWith('/api/data-cards/recycle-owned?')) return Response.json({ success: true, accountFenceVersion: 1, ownerUserId: 7, cards: [row], total: 1, filteredCount: 1, nextOffset: null });
    throw new Error(`非预期请求 ${url}`);
  });
  vi.stubGlobal('fetch', fetcher); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('真实Web回收站→现有详情仅两条owned GET，无metadata/rating/report副请求及标签写入口', async () => {
  function Harness() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>打开云端回收站</button><RecycleBinModal isOpen={open} onClose={() => setOpen(false)} limit={5} onRestore={vi.fn()} onDelete={vi.fn()} /></>; }
  await act(async () => root.render(<Harness />)); button('打开云端回收站').focus(); await act(async () => button('打开云端回收站').click());
  expect(fetcher).toHaveBeenCalledOnce(); expect(document.body.textContent).not.toContain('墓碑正文');
  const details = button('查看详情'); details.focus(); await act(async () => details.click());
  expect(document.querySelectorAll('[role=dialog]')).toHaveLength(2); expect(document.body.textContent).toContain('墓碑正文');
  expect(fetcher).toHaveBeenCalledTimes(2); expect(authStorage.getAuthHeader).not.toHaveBeenCalled(); expect(button('编辑标签')).toBeUndefined(); expect(button('举报')).toBeUndefined();
  expect(document.body.textContent).toContain('下载');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1); expect(document.activeElement).toBe(details);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(button('打开云端回收站'));
});
