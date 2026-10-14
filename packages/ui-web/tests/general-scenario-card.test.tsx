// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralScenarioCard, type GeneralScenarioCardProps } from '../src/scenario';

let container: HTMLDivElement;
let root: Root;
const render = async (props: Partial<GeneralScenarioCardProps> = {}) => {
  await act(async () => root.render(<GeneralScenarioCard scenario={{ title: '', content: '' }} {...props} />));
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('GeneralScenarioCard shared presentation', () => {
  it('preserves the card surface, branding and empty-content fallback without inventing a save action', async () => {
    await render({ scenario: { title: '', content: ' \n ' } });

    const card = container.querySelector<HTMLElement>('.result-card')!;
    expect(card.style.background).toContain('linear-gradient');
    expect(card.querySelector(':scope > .result-content')).not.toBeNull();
    expect(container.textContent).toContain('未命名情景');
    expect(container.textContent).toContain('（content 字段为空，建议补充完整的情景设定，包括背景、事件、氛围。）');
    expect(container.querySelector('img[alt="通用情景档案"]')?.getAttribute('src')).toBe('/scenario-mode.svg');
    expect(container.querySelector('.logo-placeholder img')?.getAttribute('src')).toBe('/logo-white-qrcode.svg');
    expect(container.querySelector<HTMLElement>('.logo-placeholder')?.style.display).toBe('none');
    expect(container.querySelector('button, .animate-pulse')).toBeNull();
  });

  it('updates from the streaming placeholder to partial Markdown and removes the cursor when finished', async () => {
    await render({ isStreaming: true });
    expect(container.textContent).toContain('正在启动流式生成…');
    expect(container.textContent).not.toContain('content 字段为空');
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    const scenario = { title: '雨夜车站', content: '  **末班车**驶入站台。\n ' };
    await render({ scenario, isStreaming: true });
    expect(container.textContent).toContain('雨夜车站');
    expect(container.textContent).not.toContain('正在启动流式生成…');
    expect(container.querySelector('strong')?.textContent).toBe('末班车');
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    await render({ scenario });
    expect(container.querySelector('strong')?.textContent).toBe('末班车');
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('injects the host Markdown, save button and capture ref without changing their behavior', async () => {
    const cardRef = createRef<HTMLDivElement>();
    const onSave = vi.fn();
    const renderMarkdown = vi.fn((content: string) => <div data-testid="host-markdown">{content}</div>);
    await render({
      scenario: { title: '宿主卡片', content: '  # 宿主正文\n ' },
      cardRef,
      renderMarkdown,
      saveButton: <button className="save-button mt-4" onClick={onSave}>宿主保存</button>,
    });

    expect(cardRef.current).toBe(container.querySelector('.result-card'));
    expect(renderMarkdown).toHaveBeenCalledWith('# 宿主正文');
    expect(container.querySelector('[data-testid="host-markdown"]')?.textContent).toBe('# 宿主正文');
    expect(container.querySelector('h2')).toBeNull();
    const saveButton = container.querySelector<HTMLButtonElement>('.save-button')!;
    expect(saveButton.parentElement).toBe(container.querySelector('.result-content'));
    expect(saveButton.textContent).toBe('宿主保存');
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => saveButton.click());
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('keeps external Markdown images inert by default while retaining local branding', async () => {
    await render({ scenario: { title: '安全预览', content: '![外部图片](https://external.test/scenario.png)' } });

    expect(container.textContent).toContain('![外部图片](https://external.test/scenario.png)');
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      '/scenario-mode.svg',
      '/logo-white-qrcode.svg',
    ]);
    expect(container.querySelector('video, audio, iframe, source')).toBeNull();
  });
});
