// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNameGenerationResult } from '@mahoshojo/domain/name-generation';
import { NamePageView, captureNameResultImage, type NamePageViewProps } from '../src/name-generation';

const result = buildNameGenerationResult('小满', { flowerName: '铃兰', flowerDescription: '幸福归来', appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' }, spell: '花よ\n花啊' });
let root: Root; let host: HTMLDivElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const props = (): NamePageViewProps => ({ inputName: '小满', selectedLanguage: 'zh-CN', languages: [{ code: 'zh-CN', name: '简体中文' }], onNameChange: vi.fn(), onLanguageChange: vi.fn(), onGenerate: vi.fn(), isGenerating: false, magicalGirl: result, resultRef: createRef(), onSaveImage: vi.fn(), onSaveJson: vi.fn() });
const render = async (input: NamePageViewProps) => { await act(async () => root.render(<NamePageView {...input} />)); };
const button = (text: string) => [...host.querySelectorAll('button')].find(el => el.textContent?.includes(text))!;

describe('shared classic form and result card', () => {
  it('preserves layout, labels, canonical color, language choices and brand URLs', async () => {
    await render(props());
    expect(host.querySelector('.magic-background > .container > .card')).toBeTruthy();
    expect([...host.querySelectorAll('.result-label')].map(el => el.textContent)).toEqual(['✨ 真名解放', '💝 魔法少女名', '👗 外貌', '✨ 变身咒语', '⭐ 魔法等级']);
    expect(host.querySelector('.result-card')?.getAttribute('style')).not.toContain('#123456');
    expect(host.querySelector('img[src="/mahou-title.svg"]')).toBeTruthy();
    expect(host.querySelector('.logo-placeholder img')?.getAttribute('src')).toBe('/logo-white-qrcode.svg');
    expect(host.querySelector('select')?.value).toBe('zh-CN');
    await act(async () => button('下载设定文件').click());
  });
  it('restores both action displays and the original branding display after failed capture', async () => {
    const input = props(); await render(input);
    const card = input.resultRef.current!;
    const actions = [...card.querySelectorAll<HTMLElement>('[data-name-export-action]')];
    actions[0]!.style.display = 'inline-flex'; actions[1]!.style.display = 'grid';
    const logo = card.querySelector<HTMLElement>('.logo-placeholder')!;
    const capture = vi.fn(async () => {
      expect(actions.map(el => el.style.display)).toEqual(['none', 'none']); expect(logo.style.display).toBe('flex');
      throw new Error('canvas failed');
    });
    await expect(captureNameResultImage(card, capture)).rejects.toThrow('canvas failed');
    expect(actions.map(el => el.style.display)).toEqual(['inline-flex', 'grid']); expect(logo.style.display).toBe('none');
  });
  it('single-flights export, prevents generation and retains the result when export fails', async () => {
    let fail!: (reason: Error) => void;
    const input = props(); input.captureImage = vi.fn(() => new Promise<Blob>((_resolve, reject) => { fail = reject; }));
    await render(input);
    await act(async () => { button('保存为图片').click(); button('保存为图片').click(); button('へんしん').click(); });
    expect(input.captureImage).toHaveBeenCalledTimes(1); expect(input.onGenerate).not.toHaveBeenCalled();
    await act(async () => fail(new Error('disk full')));
    expect(host.textContent).toContain('导出失败，当前结果已保留：disk full');
    expect(host.querySelector('.result-card')?.textContent).toContain('铃兰');
    expect((button('下载设定文件') as HTMLButtonElement).disabled).toBe(false);
    await render({ ...input, magicalGirl: { ...result, name: '新结果' } });
    expect(host.textContent).not.toContain('disk full');
  });
  it.each(['replace', 'unmount'])('ignores a late PNG after %s without delivering another card', async action => {
    let finish!: (blob: Blob) => void;
    const input = props(); input.captureImage = vi.fn(() => new Promise<Blob>(resolve => { finish = resolve; }));
    await render(input); await act(async () => button('保存为图片').click());
    if (action === 'replace') await render({ ...input, magicalGirl: { ...result, name: '新结果' } });
    else await act(async () => root.render(null));
    await act(async () => finish(new Blob(['png'], { type: 'image/png' })));
    expect(input.onSaveImage).not.toHaveBeenCalled();
  });
  it('does not generate for blank input, disabled mode or IME composition', async () => {
    const input = props(); await render({ ...input, inputName: ' ' });
    expect((button('へんしん') as HTMLButtonElement).disabled).toBe(true);
    await render({ ...input, generateDisabled: true });
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await render(input);
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    expect(input.onGenerate).not.toHaveBeenCalled();
  });
});
