// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuestionnaireLanguageSection } from '../src/details-controls/index';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each(['details', 'canshou', 'creator'] as const)('%s keeps the disclosure linked to its panel and preserves the selected language across collapse', (variant) => {
  function Host() {
    const [expanded, setExpanded] = useState(false);
    const [value, setValue] = useState('zh-CN');
    return <QuestionnaireLanguageSection variant={variant} expanded={expanded} onToggle={() => setExpanded(!expanded)} languages={[{ code: 'zh-CN', name: '简体中文' }, { code: 'en', name: 'English' }]} value={value} onChange={setValue} />;
  }
  act(() => root.render(<Host />));
  const button = container.querySelector('button')!;
  const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(panel.hidden).toBe(true);
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const select = container.querySelector('select')!;
  expect(select.getAttribute('aria-label')).toBe('生成语言');
  act(() => { select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  act(() => button.click());
  act(() => button.click());
  expect(container.querySelector('select')?.value).toBe('en');
});

it('uses the Creator surface only for Creator and gives simultaneous panels distinct identities', () => {
  const props = { expanded: true, onToggle: vi.fn(), languages: [{ code: 'en', name: 'English' }], value: 'en', onChange: vi.fn() };
  act(() => root.render(<><QuestionnaireLanguageSection variant="creator" {...props} /><QuestionnaireLanguageSection variant="details" {...props} /></>));
  const creator = container.querySelector('[data-creator-advanced-card="language"]')!;
  expect(creator.getAttribute('data-creator-surface')).toBe('subpanel');
  expect(creator.className).toContain('--creator-subpanel-bg');
  expect(creator.querySelector('select')?.className).toContain('--creator-input-bg');
  expect(creator.querySelector('select')?.className).toContain('focus-visible:ring-2');
  expect(creator.querySelector('select')?.className).toContain('focus-visible:ring-[var(--app-focus-ring)]');
  expect(container.querySelectorAll('[data-creator-control="field"]')).toHaveLength(1);
  expect(container.querySelectorAll('select.input-field')).toHaveLength(1);
  const buttons = [...container.querySelectorAll('button')];
  const ids = buttons.map((button) => button.getAttribute('aria-controls'));
  expect(new Set(ids).size).toBe(2);
  ids.forEach((id) => expect(document.getElementById(id!)).not.toBeNull());
});

it('keeps a host fallback language and the generation disable gate', () => {
  act(() => root.render(<QuestionnaireLanguageSection variant="details" expanded onToggle={vi.fn()} languages={[{ code: 'custom', name: '当前语言' }]} value="custom" onChange={vi.fn()} disabled />));
  expect(container.querySelector('select')?.value).toBe('custom');
  expect(container.querySelector('select')?.disabled).toBe(true);
});
