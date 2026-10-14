// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavernConversionControls, type TavernConversionControlsProps } from '../src/tavern';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === text)!;
const props = (): TavernConversionControlsProps => ({
  mode: 'ai', onModeChange: vi.fn(), language: 'zh-CN', languages: [{ code: 'zh-CN', name: '中文' }, { code: 'en', name: 'English' }],
  onLanguageChange: vi.fn(), languageExpanded: true, onLanguageExpandedChange: vi.fn(),
  generationMode: 'non-stream', onGenerationModeChange: vi.fn(), provider: <div data-provider>宿主连接</div>, providerFootnote: '宿主凭据说明',
});

describe('shared Tavern conversion controls', () => {
  it('emits controlled changes without creating state or generation side effects', () => {
    const input = props(); act(() => root.render(<TavernConversionControls {...input} />));
    act(() => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    expect(input.onModeChange).toHaveBeenCalledWith('rules');
    expect(container.querySelector('[data-provider]')).not.toBeNull();
    const language = container.querySelector('select')!;
    act(() => { language.value = 'en'; language.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(input.onLanguageChange).toHaveBeenCalledWith('en');
    act(() => button('流式').click()); expect(input.onGenerationModeChange).toHaveBeenCalledWith('stream');
    expect(button('非流式').getAttribute('aria-pressed')).toBe('true');
    act(() => button('生成语言▲').click()); expect(input.onLanguageExpandedChange).toHaveBeenCalledWith(false);
    expect(container.textContent).not.toContain('完整战报');
    act(() => root.render(<TavernConversionControls {...input} mode="rules" />));
    expect(container.querySelector('[data-provider]')).toBeNull(); expect(container.querySelector('select')).toBeNull();
  });
  it('respects explicit Desktop capabilities without changing Web defaults', () => {
    const input = props();
    act(() => root.render(<TavernConversionControls {...input} aiDisabledReason="残兽仅支持规则映射"
      generationModeDisabledReasons={{ stream: '此入口仅支持非流式 Direct' }}
      generationModeDescription="完成后一次性展示通用卡" aiDescription="输入将发送到所选 Direct 服务商" />));
    const ai = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    expect(ai.disabled).toBe(true); expect(container.textContent).toContain('残兽仅支持规则映射');
    act(() => ai.click()); expect(input.onModeChange).not.toHaveBeenCalled();
    expect(button('流式').disabled).toBe(true); expect(button('流式').title).toContain('此入口仅支持非流式 Direct');
    act(() => button('流式').click()); expect(input.onGenerationModeChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('宿主凭据说明');
    act(() => root.render(<TavernConversionControls {...input} />));
    expect(button('流式').disabled).toBe(false); expect(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].disabled).toBe(false);
    expect(container.textContent).toContain('输出会通过 schema 校验');
  });
  it('disables unsupported rules without disabling AI or altering host state', () => {
    const input = props(); act(() => root.render(<TavernConversionControls {...input} rulesDisabledReason="结构化情景尚未提供规则映射" />));
    const [rules, ai] = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(rules.disabled).toBe(true); expect(ai.disabled).toBe(false); expect(ai.checked).toBe(true);
    expect(container.textContent).toContain('尚未提供规则映射');
    act(() => rules.click()); expect(input.onModeChange).not.toHaveBeenCalled();
  });
  it('locks controls while busy and leaves collapsed language display controlled by the host', () => {
    const input = props(); act(() => root.render(<TavernConversionControls {...input} disabled />));
    expect([...container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')].every((control) => control.disabled)).toBe(true);
    act(() => button('流式').click()); expect(input.onGenerationModeChange).not.toHaveBeenCalled();
    act(() => root.render(<TavernConversionControls {...input} languageExpanded={false} />));
    expect(container.querySelector('select')).toBeNull(); expect(container.textContent).toContain('当前：zh-CN');
  });
});
