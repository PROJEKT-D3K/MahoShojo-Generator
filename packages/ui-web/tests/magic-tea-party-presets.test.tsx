// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAGIC_TEA_PARTY_PRESETS, projectMagicTeaPartyPreset } from '@mahoshojo/ai-core/magic-tea-party';
import { MagicTeaPartyPresetPicker } from '../src/magic-tea-party';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const render = async (node: ReactNode) => act(async () => root.render(node));
const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!;
const source = { settings: { providerId: 'openai', modelId: 'test' } };
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('offers plain creation and every shared preset while leaving creation ownership to the host', async () => {
  const create = vi.fn(); await render(<MagicTeaPartyPresetPicker onCreateSession={create} />);
  await act(async () => button('新建普通茶会').click()); expect(create).toHaveBeenLastCalledWith(null);
  for (const preset of MAGIC_TEA_PARTY_PRESETS) {
    await act(async () => button(`新建${preset.title}`).click()); expect(create).toHaveBeenLastCalledWith(preset.id);
  }
  expect(create).toHaveBeenCalledTimes(4); expect(container.querySelector('[aria-pressed]')).toBeNull();
});

it('keeps selection and preview controlled and requires a separate explicit apply callback', async () => {
  const select = vi.fn(), confirm = vi.fn(), cancel = vi.fn(), create = vi.fn();
  const props = { selectedPresetId: 'arena-classic', onCreateSession: create, onSelectPreset: select, onConfirmPreset: confirm, onCancelPreset: cancel };
  await render(<MagicTeaPartyPresetPicker {...props} />);
  expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain('经典战报');
  const target = [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')].find(node => node.textContent?.startsWith('日常互动'))!;
  await act(async () => target.click()); expect(select).toHaveBeenCalledWith('arena-daily');
  expect(confirm).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="预设变更预览"]')).toBeNull();
  const projection = projectMagicTeaPartyPreset(source, 'arena-daily')!;
  await render(<MagicTeaPartyPresetPicker {...props} preview={projection} />);
  for (const text of ['JSONL', '4 个行动选项', '必要时输出', '主情景替换为「A.R.E.N.A.」', '清空所有辅助情景', '角色、聊天历史、摘要和输入草稿保持不变']) expect(container.textContent).toContain(text);
  await act(async () => button('返回，不更改').click()); expect(cancel).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
  await act(async () => button('确认应用预设').click()); expect(confirm).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain('经典战报');
});

it('previews same-preset removal and blocks every action while the host is busy', async () => {
  const select = vi.fn(), confirm = vi.fn(), cancel = vi.fn(), create = vi.fn();
  const preview = projectMagicTeaPartyPreset({ settings: { ...source.settings, presetId: 'arena-classic' } }, 'arena-classic')!;
  const props = { selectedPresetId: 'arena-classic', onCreateSession: create, onSelectPreset: select, preview, onConfirmPreset: confirm, onCancelPreset: cancel };
  await render(<MagicTeaPartyPresetPicker {...props} />);
  expect(container.textContent).toContain('输出格式和行动选项设置保持不变');
  expect(container.textContent).toContain('保留手动添加的情景');
  await act(async () => button('确认取消预设').click()); expect(confirm).toHaveBeenCalledOnce(); confirm.mockClear();
  await render(<MagicTeaPartyPresetPicker {...props} disabled />);
  await act(async () => { for (const item of container.querySelectorAll('button')) item.click(); });
  for (const fn of [create, select, confirm, cancel]) expect(fn).not.toHaveBeenCalled();
});
