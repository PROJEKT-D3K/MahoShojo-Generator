// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BattleReportCardWidthSettings, normalizeBattleReportCardWidthMode, normalizeBattleReportCardWidthPx, resolveBattleReportCardManualWidthPx, resolveBattleReportCardPresetWidth, type BattleReportCardWidthSettingsValue } from '../src/arena';
import { BattleReportCard, StreamingBattleReportCard } from '../src/arena-report';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[type=radio]')];
const setInput = (value: string) => act(() => {
  const input = container.querySelector<HTMLInputElement>('input[type=number]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const report = { reporterInfo: { name: '记者', publication: '日报' }, headline: '标题', article: { body: '正文', analysis: '分析' }, officialReport: { winner: '甲', conclusion: '结论' } };
function Sample() {
  const [value, setValue] = useState<BattleReportCardWidthSettingsValue>({ battleReportCardWidthPx: 777 });
  const width = resolveBattleReportCardManualWidthPx(value);
  return <><BattleReportCardWidthSettings value={value} onChange={patch => setValue(current => ({ ...current, ...patch }))} />
    <BattleReportCard report={report} cardWidthPx={width} /><StreamingBattleReportCard content="正文" cardWidthPx={width} /></>;
}
describe('shared battle report card width', () => {
  it('keeps legacy defaults, numeric rounding, clamping and preset semantics', () => {
    for (const value of [undefined, null, 'manual ', 'auto', 1]) expect(normalizeBattleReportCardWidthMode(value)).toBe('auto');
    expect(normalizeBattleReportCardWidthMode('manual')).toBe('manual');
    for (const value of [undefined, null, '760', NaN, Infinity, -Infinity]) expect(normalizeBattleReportCardWidthPx(value)).toBe(500);
    expect(normalizeBattleReportCardWidthPx(638.6)).toBe(639);
    expect(normalizeBattleReportCardWidthPx(0)).toBe(360); expect(normalizeBattleReportCardWidthPx(1201)).toBe(1200);
    for (const value of [500, 640, 760, 920]) expect(resolveBattleReportCardPresetWidth(value)).toBe(value);
    expect(resolveBattleReportCardPresetWidth(777)).toBeNull();
    expect(resolveBattleReportCardManualWidthPx(null)).toBeNull();
    expect(resolveBattleReportCardManualWidthPx({ battleReportCardWidthMode: 'manual' })).toBe(500);
  });
  it('changes both real cards, preserves manual width through auto, and keeps native labels', () => {
    act(() => root.render(<Sample />));
    const widths = () => [...container.querySelectorAll<HTMLElement>('.result-card')].map(node => node.style.maxWidth);
    expect(widths()).toEqual(['100%', '100%']); expect(container.querySelector('input[type=number]')).toBeNull();
    act(() => radios()[1].click()); expect(widths()).toEqual(['777px', '777px']);
    const input = container.querySelector<HTMLInputElement>('input[type=number]')!;
    expect(input.labels?.[0].textContent).toBe('自定义宽度（px）');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toContain('360px - 1200px');
    for (const value of [500, 640, 760, 920]) {
      const preset = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(node => node.textContent?.includes(`· ${value}px`))!;
      preset.focus(); expect(document.activeElement).toBe(preset); act(() => preset.click());
      expect(preset.getAttribute('aria-pressed')).toBe('true'); expect(widths()).toEqual([`${value}px`, `${value}px`]);
    }
    act(() => radios()[0].click()); expect(widths()).toEqual(['100%', '100%']);
    act(() => radios()[1].click()); expect(widths()).toEqual(['920px', '920px']);
    setInput('638.6'); expect(widths()).toEqual(['639px', '639px']);
    setInput('9999'); expect(widths()).toEqual(['1200px', '1200px']);
    setInput(''); expect(widths()).toEqual(['360px', '360px']);
  });
  it('isolates multiple radio groups and disables every editable control', () => {
    const onChange = vi.fn();
    act(() => root.render(<><BattleReportCardWidthSettings value={{ battleReportCardWidthMode: 'manual' }} onChange={onChange} disabled />
      <BattleReportCardWidthSettings value={{}} onChange={onChange} /></>));
    expect(radios()[0].name).not.toBe(radios()[2].name);
    expect(new Set([...container.querySelectorAll('[id]')].map(node => node.id)).size).toBe(container.querySelectorAll('[id]').length);
    const first = container.querySelector('fieldset')!;
    expect(document.getElementById(first.getAttribute('aria-labelledby')!)?.textContent).toBe('战报卡片宽度');
    for (const control of first.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) { expect(control.disabled).toBe(true); act(() => control.click()); }
    expect(onChange).not.toHaveBeenCalled();
  });
});
