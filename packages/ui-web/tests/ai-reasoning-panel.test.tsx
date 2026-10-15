// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test } from 'vitest';
import { AiReasoningPanel } from '../src/details-controls/AiReasoningPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));
afterAll(() => { act(() => root.unmount()); container.remove(); });

test('retains the default overlay and offers a stable dark surface for light Tavern cards', () => {
  const reasoning = { status: 'done' as const, text: '返回的可展示内容', source: 'provider' as const };
  act(() => root.render(<AiReasoningPanel reasoning={reasoning} defaultExpanded />));
  const panel = container.querySelector('.ai-reasoning-panel')!;
  expect(panel.classList.contains('bg-black/20')).toBe(true);
  expect(panel.classList.contains('bg-slate-900')).toBe(false);
  act(() => root.render(<AiReasoningPanel reasoning={reasoning} background="solid-dark" defaultExpanded />));
  expect(panel.classList.contains('bg-slate-900')).toBe(true);
  expect(panel.classList.contains('bg-black/20')).toBe(false);
  expect(panel.textContent).toContain('返回的可展示内容');
});

test('does not invent reasoning for idle or content-only unavailable envelopes', () => {
  act(() => root.render(<AiReasoningPanel background="solid-dark" />));
  expect(container.innerHTML).toBe('');
  act(() => root.render(<AiReasoningPanel reasoning={{ status: 'unavailable', source: 'unknown', text: '' }} displayMode="content-only" background="solid-dark" />));
  expect(container.innerHTML).toBe('');
});
