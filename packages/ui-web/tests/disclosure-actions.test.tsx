// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CharacterManagerGuide } from '../src/character-manager/guide';
import { ScenarioBlankFields } from '../src/scenario/ScenarioFields';
import { SublimationPreserveFields } from '../src/sublimation/SublimationFields';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const expectInteractiveStyle = (button: HTMLButtonElement) => {
  expect(button.className.split(' ')).toEqual(expect.arrayContaining([
    'hover:underline', 'focus-visible:ring-2', 'focus-visible:ring-fuchsia-500',
    'focus-visible:ring-offset-2', 'disabled:opacity-50', 'disabled:cursor-not-allowed',
  ]));
  expect(button.classList.contains('focus:outline-none')).toBe(false);
  button.focus(); expect(document.activeElement).toBe(button);
};

it('keeps the guide toggle and its host content while sharing visible interaction states', () => {
  act(() => root.render(<CharacterManagerGuide capabilities={{ cloudCards: 'none', tachie: false, questionnaireEditor: false, templateSelect: false, nativenessInfo: false, sensitiveWords: false, scenarioEditors: false }} saveAndExportText="本地保存说明" />));
  const button = container.querySelector('button')!;
  expectInteractiveStyle(button);
  expect(container.textContent).toContain('本地保存说明');
  act(() => button.click());
  expect(button.textContent).toBe('▶ 使用指南');
  expect(container.textContent).not.toContain('本地保存说明');
  act(() => button.click());
  expect(container.textContent).toContain('本地保存说明');
});

it('keeps scenario expansion controlled by the host', () => {
  const toggle = vi.fn();
  const render = (expanded: boolean) => act(() => root.render(<ScenarioBlankFields expanded={expanded} onToggle={toggle} fields={[]} onChange={vi.fn()} />));
  render(false);
  const button = container.querySelector('button')!;
  expectInteractiveStyle(button);
  act(() => button.click()); expect(toggle).toHaveBeenCalledOnce();
  expect(container.querySelector('input')).toBeNull();
  render(true); expect(container.querySelector('input')).not.toBeNull();
  expect(button.textContent).toBe('▼ 高级选项：强制留空字段');
});

it('retains the sublimation disabled guard and controlled expansion', () => {
  const toggle = vi.fn();
  const render = (disabled: boolean, expanded = false) => act(() => root.render(<SublimationPreserveFields
    disabled={disabled} expanded={expanded} hasSource targetTemplate="general" fieldsToPreserve={[]}
    allowReshapeNames={false} onToggle={toggle} onAllowReshapeNamesChange={vi.fn()} onFieldChange={vi.fn()} onPreset={vi.fn()}
  />));
  render(false);
  const button = container.querySelector('button')!;
  expectInteractiveStyle(button);
  act(() => button.click()); expect(toggle).toHaveBeenCalledOnce();
  expect(container.querySelector('fieldset')).toBeNull();
  render(true, true); act(() => button.click());
  expect(button.disabled).toBe(true); expect(toggle).toHaveBeenCalledOnce();
  expect(container.querySelector('fieldset')?.disabled).toBe(true);
});
