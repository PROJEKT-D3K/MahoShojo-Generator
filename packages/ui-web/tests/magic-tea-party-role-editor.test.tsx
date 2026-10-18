// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MagicTeaPartyRoleEditor } from '../src/magic-tea-party';
import { applyMagicTeaPartyRoleDraft } from '@mahoshojo/domain/magic-tea-party/role-editor';
import type { MagicTeaPartyRole } from '@mahoshojo/domain/magic-tea-party/types';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const source: MagicTeaPartyRole = { id: 'a', name: '星', source: 'local', card: { name: '星', current_state: { summary: '旧摘要', extension: 1 } } };
let root: Root, container: HTMLDivElement;
const save = vi.fn(), dirty = vi.fn(), busy = vi.fn();
const render = (role: MagicTeaPartyRole | null = source, scope = 'session-a', disabled = false, hidden = false, additionalDirty = false) => act(async () => root.render(
  <MagicTeaPartyRoleEditor allowDiscardAll role={role} scope={scope} disabled={disabled} hidden={hidden} additionalDirty={additionalDirty} onSave={save} onDirtyChange={dirty} onBusyChange={busy} />));
const input = (label = '角色名称') => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!;
const edit = (value: string, label = '角色名称') => act(async () => {
  const node = input(label); Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});
beforeEach(async () => { save.mockReset().mockImplementation(async (role, draft) => applyMagicTeaPartyRoleDraft(role, draft, 'now')); dirty.mockReset(); busy.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); await render(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('labels fields, retains focus while typing, submits by native form, and waits for a real acknowledgement', async () => {
  let finish!: (value: MagicTeaPartyRole | null) => void; save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  input().focus(); await edit('新名'); expect(document.activeElement).toBe(input()); expect(dirty).toHaveBeenLastCalledWith(true);
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(save).toHaveBeenCalledOnce(); expect(input().matches(':disabled')).toBe(true); expect(button('重置').matches(':disabled')).toBe(true);
  expect(container.textContent).not.toContain('已保存到本地会话');
  await act(async () => finish(applyMagicTeaPartyRoleDraft(source, { name: '新名', notes: '', currentState: '旧摘要' }, 'now')));
  expect(container.textContent).toContain('已保存到本地会话'); expect(dirty).toHaveBeenLastCalledWith(false); expect(busy).toHaveBeenLastCalledWith(false);
});
it.each(['rejected', 'failed'] as const)('preserves %s saves and permits an explicit retry', async kind => {
  if (kind === 'rejected') save.mockResolvedValueOnce(null); else save.mockRejectedValueOnce(new Error('磁盘写入失败'));
  await edit('保留草稿'); await act(async () => button('保存修改').click());
  expect(input().value).toBe('保留草稿'); expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(dirty).toHaveBeenLastCalledWith(true);
  await act(async () => button('保存修改').click()); expect(save).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('已保存到本地会话');
});
it.each(['role', 'session', 'roundtrip'] as const)('isolates a late result after a %s switch and keeps scoped drafts', async kind => {
  let finish!: (value: MagicTeaPartyRole) => void; save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await edit('原目标草稿'); await act(async () => button('保存修改').click());
  const other = { ...source, id: 'b', name: '月' };
  await render(kind === 'role' ? other : source, kind === 'role' ? 'session-a' : 'session-b');
  if (kind === 'roundtrip') await render();
  const before = input().value;
  await act(async () => finish({ ...source, name: '原目标草稿' }));
  expect(input().value).toBe(before); expect(container.textContent).not.toContain('已保存到本地会话');
  await render(); expect(input().value).toBe('原目标草稿');
});
it('preserves drafts across temporary null and supports reset to an externally changed source', async () => {
  await edit('未保存'); await render(null); await render({ ...source, name: '外部新名' });
  expect(input().value).toBe('未保存');
  await act(async () => button('重置').click()); expect(input().value).toBe('外部新名'); expect(save).not.toHaveBeenCalled(); expect(dirty).toHaveBeenLastCalledWith(false);
});
it('does not save on Escape or composition Enter, and host busy disables editing and reset', async () => {
  await edit('键盘草稿');
  const composition = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  await act(async () => { input().dispatchEvent(composition); input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(composition.defaultPrevented).toBe(true); expect(save).not.toHaveBeenCalled(); expect(input().value).toBe('键盘草稿');
  await render(source, 'session-a', true); await act(async () => button('重置').click()); expect(input().value).toBe('键盘草稿'); expect(input().matches(':disabled')).toBe(true);
});

it('accepts a host rollback to the original role after the saved role has been absorbed', async () => {
  await edit('已保存新名'); await act(async () => button('保存修改').click());
  const saved = await save.mock.results[0]!.value as MagicTeaPartyRole;
  expect(input().value).toBe('已保存新名');
  expect(container.textContent).toContain('角色修改已保存到本地会话');
  await render(saved);
  expect(input().value).toBe('已保存新名'); expect(dirty).toHaveBeenLastCalledWith(false);
  await render(source);
  expect(input().value).toBe(source.name);
  expect(container.textContent).not.toContain('角色修改已保存到本地会话');
  expect(dirty).toHaveBeenLastCalledWith(false); expect(button('保存修改').disabled).toBe(true);
});

it('keeps orphaned drafts and exposes an unhidden discard-all action requiring explicit confirmation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const other = { ...source, id: 'b', name: '月' };
  await edit('星的未保存原文');
  await render(other, 'session-b'); await edit('月的未保存原文');
  await render(other, 'session-b', false, true);
  expect(button('放弃全部角色草稿')).toBeTruthy();
  expect(button('放弃全部角色草稿').closest('[hidden]')).toBeNull();
  await render(null, 'session-b', false, true);
  expect(button('放弃全部角色草稿').closest('[hidden]')).toBeNull();
  await act(async () => button('放弃全部角色草稿').click());
  expect(confirm).toHaveBeenCalledOnce(); expect(dirty).toHaveBeenLastCalledWith(true);
  const stillProtected = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(stillProtected); expect(stillProtected.defaultPrevented).toBe(true);
  await render(source); expect(input().value).toBe('星的未保存原文');
  await render(other, 'session-b'); expect(input().value).toBe('月的未保存原文');
  await render(null, 'session-b', false, true);
  confirm.mockReturnValue(true);
  await act(async () => button('放弃全部角色草稿').click());
  expect(confirm).toHaveBeenCalledTimes(2); expect(dirty).toHaveBeenLastCalledWith(false);
  const released = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(released); expect(released.defaultPrevented).toBe(false);
  await render(source); expect(input().value).toBe(source.name);
  await render(other, 'session-b'); expect(input().value).toBe(other.name);
  expect(save).not.toHaveBeenCalled();
});

it('cannot discard role drafts during a save or a host-busy period', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  let finish!: (value: MagicTeaPartyRole | null) => void;
  save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await edit('正在保存的原文'); await act(async () => button('保存修改').click());
  expect(button('放弃全部角色草稿').matches(':disabled')).toBe(true);
  await act(async () => button('放弃全部角色草稿').click()); expect(confirm).not.toHaveBeenCalled();
  await act(async () => finish(null));
  expect(input().value).toBe('正在保存的原文'); expect(dirty).toHaveBeenLastCalledWith(true);
  await render(null, 'session-a', true);
  expect(button('放弃全部角色草稿').matches(':disabled')).toBe(true);
  await act(async () => button('放弃全部角色草稿').click()); expect(confirm).not.toHaveBeenCalled();
  await render(); expect(input().value).toBe('正在保存的原文');
  expect(button('放弃全部角色草稿').matches(':disabled')).toBe(false);
});

it('freezes the accepted latest source when host-only editing begins after a clean external update', async () => {
  await edit('已保存名称'); await act(async () => button('保存修改').click());
  const saved = applyMagicTeaPartyRoleDraft(source, { name: '已保存名称', notes: '', currentState: '旧摘要' }, 'now');
  await render(saved);
  const latest = { ...saved, name: '外部最新名称', card: { ...saved.card, name: '外部最新名称' } };
  await render(latest); expect(input().value).toBe('外部最新名称');
  await render(latest, 'session-a', false, false, true);
  expect(input().value).toBe('外部最新名称');
  await act(async () => button('保存修改').click());
  expect(save.mock.calls.at(-1)?.[0]).toBe(latest);
});
