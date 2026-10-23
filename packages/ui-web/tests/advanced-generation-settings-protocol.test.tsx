// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvancedGenerationSettings } from '../src/ai-provider/advanced-generation-settings';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('AdvancedGenerationSettings explicit protocol limits', () => {
  it.each([false, true])('keeps the legacy model warning editable unless the host explicitly disables temperature: %s', async disabled => {
    const onChange = vi.fn();
    const value = { temperature: 0.8, maxOutputTokens: 6000, thinking: { mode: 'enabled' as const, effort: 'high' as const } };
    await act(async () => root.render(<AdvancedGenerationSettings value={value} onChange={onChange}
      temperatureSupported={false} temperatureDisabled={disabled} thinkingSupport="unsupported"
      {...(disabled ? { temperatureHint: '本协议温度不生效', maxOutputTokensHint: '本客户端默认 4096', thinkingHint: '本协议推理设置不生效' } : {})} />));
    await act(async () => container.querySelector('button')!.click());
    const [maxTokens, temperature] = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    expect(temperature!.disabled).toBe(disabled);
    expect(temperature!.value).toBe('0.8');
    expect(maxTokens!.disabled).toBe(false);
    expect(container.textContent).toContain(disabled ? '本协议温度不生效' : '当前模型可能不支持 temperature');
    expect(container.textContent).toContain(disabled ? '本客户端默认 4096' : '留空则使用模型 / 供应商默认');
    expect(container.textContent).toContain(disabled ? '本协议推理设置不生效' : '当前模型不支持自定义推理设置');
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(maxTokens, '7000');
      maxTokens!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, maxOutputTokens: 7000 });
  });
});
