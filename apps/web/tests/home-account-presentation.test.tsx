// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ push: vi.fn(), auth: { user: { username: 'homura' }, userBadges: [{ id: 1, userId: 7, badgeId: 'test', isEquipped: true, displayOrder: 1, obtainedAt: '', badge: { id: 'test', name: '测试徽章', icon: { type: 'emoji', value: '⭐' }, textColor: { type: 'solid', value: '#000' }, backgroundColor: { type: 'solid', value: '#fff' }, rarity: 1, sortOrder: 1, isActive: true } }], isAuthenticated: true, loading: false } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/components/Footer', () => ({ default: () => <footer /> }));
import { HomePage } from '@/components/home/HomePage';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.auth.isAuthenticated = true;
  mocks.auth.loading = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('assembles the real username component inside the shared emphasis and navigates to battle history', () => {
  act(() => root.render(<HomePage />));
  const welcome = container.querySelector('[data-testid="home-account-welcome"]')!;
  const name = welcome.querySelector('.font-semibold')!;
  expect(name.tagName).toBe('DIV');
  expect(name.querySelector('div > span')?.textContent).toBe('homura');
  expect(name.textContent).toContain('测试徽章');
  expect(name.querySelector('.font-medium')).not.toBeNull();
  expect(welcome.querySelectorAll('a')).toHaveLength(2);
  expect(welcome.querySelector('a a')).toBeNull();
  const me = welcome.querySelector<HTMLAnchorElement>('a[href="/me"]')!;
  expect(me.textContent).toBe('个人页：战报记录（测试版）');
  act(() => me.click());
  expect(mocks.push).toHaveBeenCalledWith('/me');
});

it.each(['loading', 'anonymous'])('keeps the %s homepage free of account links', (state) => {
  mocks.auth.isAuthenticated = false;
  mocks.auth.loading = state === 'loading';
  act(() => root.render(<HomePage />));
  expect(container.querySelector('[data-testid="home-account-welcome"] a')).toBeNull();
});
