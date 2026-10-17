// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Preset } from '@mahoshojo/domain/presets';
import { CharacterPresetPicker, type CharacterPresetPickerProps } from '../src/arena';

const makePresets = (type: Preset['type']) => Array.from({ length: 5 }, (_, index) => ({ type, name: `${type}-${index}`, filename: `${type}-${index}.json`, description: '合成预设' }));
const grouped = { magicalGirl: makePresets('magical-girl'), canshou: makePresets('canshou') };
let root: Root, container: HTMLDivElement;
beforeEach(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function Picker(props: Partial<CharacterPresetPickerProps>) {
  const [magicalGirlPage, setMagicalGirlPage] = useState(1), [canshouPage, setCanshouPage] = useState(1);
  return <CharacterPresetPicker grouped={grouped} magicalGirlPage={magicalGirlPage} onMagicalGirlPageChange={setMagicalGirlPage} canshouPage={canshouPage} onCanshouPageChange={setCanshouPage} selectedFilenames={[]} onToggle={vi.fn()} {...props} />;
}
const group = (title: string) => [...container.querySelectorAll('h3')].find(heading => heading.textContent === title)!.parentElement!;
const action = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe('shared character preset groups', () => {
  it('keeps the Web titles, four-card grids and independent page positions', async () => {
    await act(async () => root.render(<Picker />));
    const girls = group('选择预设魔法少女'), monsters = group('选择预设残兽');
    expect(girls.querySelectorAll('[aria-pressed]')).toHaveLength(4);
    expect(monsters.querySelectorAll('[aria-pressed]')).toHaveLength(4);
    await act(async () => [...girls.querySelectorAll('button')].find(button => button.textContent === '下一页')!.click());
    expect(girls.textContent).toContain('magical-girl-4'); expect(girls.textContent).toContain('第 2 / 2 页');
    expect(monsters.textContent).toContain('canshou-0'); expect(monsters.textContent).toContain('第 1 / 2 页');
  });
  it('preserves total-count limits, deselection and independent download actions', async () => {
    const onToggle = vi.fn(), onDownload = vi.fn();
    await act(async () => root.render(<Picker selectedFilenames={['magical-girl-0.json']} selectedCountOverride={32} maxSelected={32} onToggle={onToggle} onDownload={onDownload} />));
    expect(action('选择预设角色：canshou-0').disabled).toBe(true);
    expect(action('取消选择预设角色：magical-girl-0').disabled).toBe(false);
    await act(async () => action('下载预设：canshou-0').click());
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(grouped.canshou[0]); expect(onToggle).not.toHaveBeenCalled();
    await act(async () => action('取消选择预设角色：magical-girl-0').click());
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(grouped.magicalGirl[0]);
  });
  it('forwards loading, disabled state and the host download link unchanged', async () => {
    await act(async () => root.render(<Picker disabled loadingFilename="magical-girl-0.json" getDownloadHref={filename => `/presets/${encodeURIComponent(filename)}`} />));
    expect(group('选择预设魔法少女').textContent).toContain('加载中...');
    expect(action('选择预设角色：magical-girl-0').disabled).toBe(true);
    const link = container.querySelector<HTMLAnchorElement>('[aria-label="下载预设：magical-girl-0"]')!;
    expect(link.getAttribute('href')).toBe('/presets/magical-girl-0.json'); expect(link.download).toBe('magical-girl-0.json');
  });
});
