// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BattleReportCardWidthSettings } from '@mahoshojo/ui-web/arena';
import { ARENA_REPORT_CARD_WIDTH_KEY, useDesktopReportCardWidth } from '../src/features/arena/use-report-card-width';
let root: Root, container: HTMLDivElement;
function Sample() { const { value, onChange, error } = useDesktopReportCardWidth(); return <><BattleReportCardWidthSettings value={value} onChange={onChange} />{error && <p role="status">{error}</p>}</>; }
const mount = () => act(() => root.render(<StrictMode><Sample /></StrictMode>));
const manual = () => act(() => container.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
const preset = () => act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('760px'))!.click());
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
it('does not write on mount and persists only local display fields while preserving extensions', () => {
  const writes = vi.spyOn(Storage.prototype, 'setItem'); mount(); expect(writes).not.toHaveBeenCalled();
  manual(); preset(); expect(JSON.parse(localStorage.getItem(ARENA_REPORT_CARD_WIDTH_KEY)!)).toEqual({ battleReportCardWidthMode: 'manual', battleReportCardWidthPx: 760 });
  localStorage.setItem(ARENA_REPORT_CARD_WIDTH_KEY, JSON.stringify({ battleReportCardWidthMode: 'manual', battleReportCardWidthPx: 640, future: { keep: true } }));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: ARENA_REPORT_CARD_WIDTH_KEY })));
  expect(container.querySelector<HTMLInputElement>('input[type=number]')?.value).toBe('640');
  preset(); expect(JSON.parse(localStorage.getItem(ARENA_REPORT_CARD_WIDTH_KEY)!)).toHaveProperty('future.keep', true);
  act(() => root.render(<div />)); mount(); expect(container.querySelector<HTMLInputElement>('input[type=number]')?.value).toBe('760');
  localStorage.removeItem(ARENA_REPORT_CARD_WIDTH_KEY); act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
  expect(container.querySelector('input[type=number]')).toBeNull();
});
it.each(['{broken', '[]', 'null'])('keeps corrupt original %s and allows memory-only changes without pretending they were saved', raw => {
  localStorage.setItem(ARENA_REPORT_CARD_WIDTH_KEY, raw); mount(); expect(container.querySelector('[role=status]')?.textContent).toContain('未能读取');
  manual(); preset(); expect(container.querySelector<HTMLInputElement>('input[type=number]')?.value).toBe('760');
  expect(localStorage.getItem(ARENA_REPORT_CARD_WIDTH_KEY)).toBe(raw); expect(container.querySelector('[role=status]')?.textContent).toContain('未能保存');
});
it('keeps the current choice on unavailable storage and failed writes, then retries on the next explicit edit', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); }); mount(); manual(); preset();
  expect(container.querySelector<HTMLInputElement>('input[type=number]')?.value).toBe('760'); expect(container.querySelector('[role=status]')?.textContent).toContain('未能保存');
  vi.restoreAllMocks(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  act(() => container.querySelectorAll<HTMLInputElement>('input[type=radio]')[0].click()); manual();
  expect(container.querySelector<HTMLInputElement>('input[type=number]')?.value).toBe('760'); expect(localStorage.getItem(ARENA_REPORT_CARD_WIDTH_KEY)).toBeNull();
  vi.restoreAllMocks(); preset(); expect(JSON.parse(localStorage.getItem(ARENA_REPORT_CARD_WIDTH_KEY)!).battleReportCardWidthPx).toBe(760); expect(container.querySelector('[role=status]')).toBeNull();
});
