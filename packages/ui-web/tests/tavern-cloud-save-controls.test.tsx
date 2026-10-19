// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DATA_CARD_BYTES } from '@mahoshojo/domain/data-card-size';
import { TavernCloudSaveControls, type TavernCloudSaveControlsProps } from '../src/tavern';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const props = (): TavernCloudSaveControlsProps => ({ preset: 'standard', onPresetChange: vi.fn(), preview: null });
const buttons = () => [...container.querySelectorAll('button')];

describe('shared Tavern cloud controls', () => {
  it('requires an explicit controlled selection, with no save action or automatic downgrade', () => {
    const input = props();
    act(() => root.render(<TavernCloudSaveControls {...input} preview={{ data: {}, estimatedBytes: MAX_DATA_CARD_BYTES + 1, overLimit: true, warnings: [] }} />));
    expect(buttons().map(button => button.textContent)).toEqual(['标准', '轻量', '极简']);
    expect(input.onPresetChange).not.toHaveBeenCalled();
    expect(buttons().map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    act(() => buttons()[1].click());
    expect(input.onPresetChange).toHaveBeenCalledExactlyOnceWith('light');
    expect(buttons()[0].getAttribute('aria-pressed')).toBe('true');
    act(() => root.render(<TavernCloudSaveControls {...input} preset="light" />));
    expect(buttons()[1].getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('轻量会按字段截断正文');
    expect(container.textContent).toContain('极简还会清空对话样例');
    expect(container.textContent).toContain('当前转换结果与本地原件不受影响');
  });

  it('honors a host lock for every preset', () => {
    const input = props();
    act(() => root.render(<TavernCloudSaveControls {...input} disabled />));
    act(() => buttons().forEach(button => button.click()));
    expect(buttons().every(button => button.disabled)).toBe(true);
    expect(input.onPresetChange).not.toHaveBeenCalled();
    act(() => root.render(<TavernCloudSaveControls {...input} />));
    act(() => buttons()[2].click());
    expect(input.onPresetChange).toHaveBeenCalledExactlyOnceWith('minimal');
  });

  it('renders host estimates and warnings with the shared limit, without promising a successful write', () => {
    const input = props();
    act(() => root.render(<TavernCloudSaveControls {...input} preview={{ data: {}, estimatedBytes: MAX_DATA_CARD_BYTES + 1024, overLimit: true, warnings: ['原件已从云副本移除'] }} />));
    expect(container.textContent).toContain('1025.0KB / 1024KB');
    expect(container.textContent).toContain('超限');
    expect(container.textContent).toContain('预估包含作者信息');
    expect(container.textContent).toContain('实际保存仍受服务端大小、配额与权限校验约束');
    expect(container.querySelector('li')?.textContent).toBe('原件已从云副本移除');
    act(() => root.render(<TavernCloudSaveControls {...input} preview={{ error: '无法序列化' }} />));
    expect(container.textContent).toContain('预估失败：无法序列化');
    expect(container.textContent).not.toContain('1025.0KB');
    act(() => root.render(<TavernCloudSaveControls {...input} />));
    expect(container.textContent).toContain('生成后会在此处显示体积预估与裁剪提示');
  });
});
