// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StoryOptionsPanel, type StoryLengthOption } from '../src/arena/StoryOptionsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Draft = {
  userGuidance: string;
  storyLength: StoryLengthOption;
  customStoryLength: string;
  selectedLanguage: string;
};

const initialDraft: Draft = {
  userGuidance: '原始故事方向',
  storyLength: 'standard',
  customStoryLength: '1200',
  selectedLanguage: '',
};

function ControlledPanel({ idPrefix, isGenerating = false, onChange = () => {} }: {
  idPrefix?: string;
  isGenerating?: boolean;
  onChange?: (field: keyof Draft, value: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const change = <K extends keyof Draft,>(field: K, value: Draft[K]) => {
    onChange(field, value);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return (
    <>
      <StoryOptionsPanel
        {...draft}
        idPrefix={idPrefix}
        isGenerating={isGenerating}
        enableUserGuidance
        allowEmptyLanguage
        languages={[{ code: 'zh-CN', name: '简体中文' }, { code: 'en-US', name: 'English' }]}
        onUserGuidanceChange={(value) => change('userGuidance', value)}
        onStoryLengthChange={(value) => change('storyLength', value)}
        onCustomStoryLengthChange={(value) => change('customStoryLength', value)}
        onSelectedLanguageChange={(value) => change('selectedLanguage', value)}
      />
      <output>{JSON.stringify(draft)}</output>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

async function render(element: ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(element));
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
});

function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(found).toBeDefined();
  return found!;
}

async function input(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function draft(): Draft {
  return JSON.parse(container.querySelector('output')!.textContent!);
}

describe('StoryOptionsPanel instance IDs', () => {
  it('keeps Web IDs and associates prefixed labels with their own controls beside a hidden mounted panel', async () => {
    await render(
      <>
        <section data-panel="web" hidden><ControlledPanel /></section>
        <section data-panel="desktop"><ControlledPanel idPrefix="desktop-host-story" /></section>
      </>,
    );

    const originalIds = ['arena-story-guidance', 'custom-story-length', 'language-select'];
    for (const [panelName, prefix] of [['web', ''], ['desktop', 'desktop-host-story-']]) {
      const panel = container.querySelector(`[data-panel="${panelName}"]`)!;
      const ids = [...panel.querySelectorAll('[id]')].map((control) => control.id);
      expect(ids).toEqual(originalIds.map((id) => `${prefix}${id}`));
      for (const label of panel.querySelectorAll<HTMLLabelElement>('label[for]')) {
        const control = panel.querySelector(`#${label.htmlFor}`);
        expect(control).not.toBeNull();
        expect(label.control).toBe(control);
        expect(document.getElementById(label.htmlFor)).toBe(control);
      }
    }

    const ids = [...container.querySelectorAll('[id]')].map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  it.each([undefined, '', 'desktop-host-story'])('preserves all four controlled callbacks with prefix %s', async (idPrefix) => {
    const changed = vi.fn();
    await render(<ControlledPanel idPrefix={idPrefix} onChange={changed} />);

    await input(container.querySelector<HTMLInputElement>('input[name="arena_story_guidance"]')!, '雨中相遇');
    await input(container.querySelector<HTMLInputElement>('input[name="custom_story_length"]')!, '1a2.50字');
    await act(async () => {
      const language = container.querySelector('select')!;
      language.value = 'en-US';
      language.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(draft()).toEqual({
      userGuidance: '雨中相遇', storyLength: 'standard', customStoryLength: '1250', selectedLanguage: 'en-US',
    });

    await act(async () => button('长篇(2000+)').click());
    expect(changed.mock.calls).toEqual([
      ['userGuidance', '雨中相遇'],
      ['customStoryLength', '1250'],
      ['selectedLanguage', 'en-US'],
      ['customStoryLength', ''],
      ['storyLength', 'long'],
    ]);
    expect(draft()).toEqual({
      userGuidance: '雨中相遇', storyLength: 'long', customStoryLength: '', selectedLanguage: 'en-US',
    });
    expect(container.querySelector('input[name="custom_story_length"]')).toBeNull();
    expect(button('长篇(2000+)').classList.contains('battle-lite-chip-active')).toBe(true);

    changed.mockClear();
    await act(async () => button('自定义').click());
    expect(container.querySelector<HTMLInputElement>('input[name="custom_story_length"]')!.value).toBe('');
    expect(changed).not.toHaveBeenCalled();
    await act(async () => button('简短(300+)').click());
    expect(changed.mock.calls).toEqual([['storyLength', 'short']]);

    await act(async () => button('清空').click());
    await act(async () => {
      const language = container.querySelector('select')!;
      language.value = '';
      language.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(changed.mock.calls).toEqual([
      ['storyLength', 'short'], ['userGuidance', ''], ['selectedLanguage', ''],
    ]);
    expect(draft()).toEqual({ userGuidance: '', storyLength: 'short', customStoryLength: '', selectedLanguage: '' });
  });

  it('disables every editable control and prevents button mutations while generating', async () => {
    const changed = vi.fn();
    await render(<ControlledPanel idPrefix="desktop-host-story" isGenerating onChange={changed} />);

    const fields = [...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id], select')];
    expect(fields).toHaveLength(3);
    for (const field of fields) {
      expect(field.disabled).toBe(true);
      field.focus();
      expect(document.activeElement).not.toBe(field);
    }
    for (const control of container.querySelectorAll('button')) {
      expect(control.disabled).toBe(true);
      await act(async () => control.click());
    }

    expect(changed).not.toHaveBeenCalled();
    expect(draft()).toEqual(initialDraft);
    expect(container.querySelector<HTMLInputElement>('input[name="arena_story_guidance"]')!.value).toBe(initialDraft.userGuidance);
    expect(container.querySelector<HTMLInputElement>('input[name="custom_story_length"]')!.value).toBe(initialDraft.customStoryLength);
    expect(container.querySelector('select')!.value).toBe(initialDraft.selectedLanguage);
  });
});
