// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useCharacterManagerCloudWrite } from '@/components/character/useCharacterManagerCloudWrite';
const mocks = vi.hoisted(() => ({ create: vi.fn(), replace: vi.fn(), target: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authStorage: { getAuth: async () => ({ userId: 7, username: 'owner' }) }, dataCardApi: { createCard: mocks.create, replaceOwnedCard: mocks.replace, readOwnedReplacementTarget: mocks.target } }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false }) }));
it('角色页面create、replace及replacement preview均遵守共享页级busy', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let blocked = false; let controller!: ReturnType<typeof useCharacterManagerCloudWrite>;
  const target = { id: 'c', type: 'character', name: '角色', description: '', isPublic: 0, reviewStatus: 'approved', hasPendingUpdate: false, version: 'a'.repeat(64) };
  mocks.create.mockResolvedValue({ success: true }); mocks.replace.mockResolvedValue({ success: true }); mocks.target.mockResolvedValue({ success: true, target });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  function Harness() { controller = useCharacterManagerCloudWrite({ data: { name: '原件' }, cardType: 'character', userId: 7, isAuthenticated: true,
    prepareData: async () => ({ name: '原件' }), onSuccess: vi.fn(), onSensitive: vi.fn(), onInspectCards: vi.fn(), isBlocked: () => blocked }); return null; }
  try {
    await act(async () => root.render(<Harness />)); await act(async () => controller.openSave());
    blocked = true; await act(async () => controller.saveModal.onSave()); await act(async () => controller.selectReplacement('c'));
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.target).not.toHaveBeenCalled();
    blocked = false; await act(async () => controller.selectReplacement('c')); expect(mocks.target).toHaveBeenCalledOnce();
    blocked = true; await act(async () => controller.replaceModal.onConfirm()); expect(mocks.replace).not.toHaveBeenCalled();
    blocked = false; await act(async () => controller.replaceModal.onConfirm()); expect(mocks.replace).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); host.remove(); }
});
