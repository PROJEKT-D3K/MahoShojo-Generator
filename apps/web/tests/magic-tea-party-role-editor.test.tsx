// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MagicTeaPartyCharacterPanel } from '@/components/magic-tea-party/CharacterPanel';
import type { MagicTeaPartyRole, MagicTeaPartySession } from '@/lib/magic-tea-party/types';

const host = vi.hoisted(() => ({ create: vi.fn(), replace: vi.fn(), deck: vi.fn(), download: vi.fn() }));
vi.mock('@/components/DecksModal', () => ({ default: () => null }));
vi.mock('@/lib/auth', () => ({ dataCardApi: { createCard: host.create, replaceCard: host.replace }, deckApi: { getDeckCards: host.deck } }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: host.download }));

let root: Root;
let container: HTMLDivElement;
let source: MagicTeaPartyRole;
let other: MagicTeaPartyRole;
let session: MagicTeaPartySession;
const save = vi.fn(), update = vi.fn(), player = vi.fn(), toggle = vi.fn();
const form = () => container.querySelector<HTMLFormElement>('form[aria-label="会话角色基础编辑"]')!;
const field = (label: string) => form().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const button = (label: string) => {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = (label: string) => act(async () => button(label).click());
const editControl = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});
const edit = (label: string, value: string) => editControl(field(label), value);
const cloudField = (caption: string) => {
  const label = [...container.querySelectorAll('label')].find(item => item.textContent === caption);
  const node = label?.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (!node) throw new Error(`Missing cloud field: ${caption}`);
  return node;
};
const render = (current = session) => act(async () => root.render(<MagicTeaPartyCharacterPanel
  activeSession={current} roles={current.roles} isAuthenticated onSaveRole={save}
  onUpdateRoles={update} onUpdatePlayerRole={player} onToggleRoleCard={toggle} />));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(async () => {
  for (const mock of [...Object.values(host), save, update, player, toggle]) mock.mockReset();
  save.mockResolvedValue(true);
  source = { id: 'first', name: '星见澪', notes: '原备注', source: 'cloud', dataCardId: 'original-cloud-card',
    signature: 'existing-signature', template: 'general', card: { templateId: '通用角色', name: '星见澪', content: '角色设定',
      current_state: { summary: '旧状态', fields: [{ label: '记忆', value: '保留' }], future: { keep: true } },
      extension: { ownUndefined: undefined, utf16: '\uD800' } } };
  other = { id: 'second', name: '月川', source: 'local', card: { name: '月川', current_state: { summary: '另一状态' } } };
  session = { id: 'session', title: '茶会', createdAt: 1, updatedAt: 1, roles: [source, other],
    settings: { providerId: 'openai', modelId: 'test' } };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  expect(host.create).not.toHaveBeenCalled(); expect(host.replace).not.toHaveBeenCalled();
  expect(host.deck).not.toHaveBeenCalled(); expect(host.download).not.toHaveBeenCalled();
});

describe('Web CharacterPanel consumes the actual shared basic role editor', () => {
  it('opens the shared form from 编辑 and awaits the real role save before announcing success', async () => {
    expect(form().hidden).toBe(true);
    await click('编辑');
    expect(form().hidden).toBe(false);
    expect(field('角色名称').value).toBe('星见澪');
    expect(field('角色备注').value).toBe('原备注');
    expect(field('当前状态摘要').value).toBe('旧状态');
    const receipt = deferred<boolean>(); save.mockReturnValueOnce(receipt.promise);
    await edit('角色名称', ' 新名称 '); await edit('角色备注', ' 新备注 '); await edit('当前状态摘要', ' 新状态 ');
    expect(save).not.toHaveBeenCalled();
    await click('保存修改');
    expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0][0]).toBe(source);
    const submitted = save.mock.calls[0][1] as MagicTeaPartyRole;
    expect(submitted).toMatchObject({ id: source.id, name: '新名称', notes: '新备注', source: 'cloud',
      dataCardId: source.dataCardId, signature: source.signature,
      card: { name: '新名称', current_state: { summary: '新状态', fields: [{ label: '记忆', value: '保留' }], future: { keep: true }, updated_at: expect.any(String) } } });
    expect(submitted.card.extension).toStrictEqual(source.card.extension);
    expect(form().getAttribute('aria-busy')).toBe('true');
    expect(field('角色名称').matches(':disabled')).toBe(true);
    expect(form().querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('角色修改已保存到本地会话');
    expect(update).not.toHaveBeenCalled();
    await act(async () => receipt.resolve(true));
    expect(form().querySelector('[role="status"]')?.textContent).toBe('角色修改已保存到本地会话。');
    expect(form().getAttribute('aria-busy')).toBe('false');
    expect(field('角色名称').value).toBe('新名称');
    expect(button('保存修改').disabled).toBe(true);
    expect(source.name).toBe('星见澪');
  });

  it.each(['rejected', 'failed'] as const)('keeps %s drafts in the real panel and retries only after an explicit save', async outcome => {
    await click('编辑');
    if (outcome === 'rejected') save.mockResolvedValueOnce(false);
    else save.mockRejectedValueOnce(new Error('本地事务失败'));
    await edit('角色名称', '失败后保留'); await edit('角色备注', '保留备注'); await edit('当前状态摘要', '保留状态');
    await click('保存修改');
    expect(field('角色名称').value).toBe('失败后保留'); expect(field('角色备注').value).toBe('保留备注');
    expect(field('当前状态摘要').value).toBe('保留状态');
    expect(form().querySelector('[role="alert"]')).not.toBeNull();
    expect(form().querySelector('[role="status"]')).toBeNull();
    expect(button('保存修改').disabled).toBe(false); expect(save).toHaveBeenCalledOnce();
    await click('保存修改');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe(source);
    expect(save.mock.calls[1][1]).toMatchObject({ name: '失败后保留', notes: '保留备注', card: { current_state: { summary: '保留状态' } } });
    expect(form().querySelector('[role="status"]')?.textContent).toContain('已保存到本地会话');
    expect(update).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not let a late first-role result %s clear another role draft', async result => {
    await click('月川'); await click('编辑'); await edit('角色名称', '月川的未保存草稿'); await edit('角色备注', '另一角色备注');
    await click('星见澪'); await click('编辑'); await edit('角色名称', '星见澪的提交稿');
    const receipt = deferred<boolean>(); save.mockReturnValueOnce(receipt.promise);
    await click('保存修改');
    await click('月川'); await click('编辑');
    expect(field('角色名称').value).toBe('月川的未保存草稿');
    await act(async () => receipt.resolve(result));
    expect(field('角色名称').value).toBe('月川的未保存草稿');
    expect(field('角色备注').value).toBe('另一角色备注');
    expect(form().querySelector('[role="status"]')).toBeNull(); expect(form().querySelector('[role="alert"]')).toBeNull();
    expect(button('保存修改').disabled).toBe(false);
    await click('星见澪'); await click('编辑');
    expect(field('角色名称').value).toBe('星见澪的提交稿');
    expect(form().querySelector('[role="status"]')).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });

  it('keeps an unsaved raw JSON draft when the same scope receives a structurally equal cloned role', async () => {
    await click('编辑'); await click('编辑角色卡 JSON');
    const rawText = JSON.stringify({ ...source.card, content: '仅高级 JSON 的未保存稿', future: { draft: ['保留'] } }, null, 2);
    await edit('角色卡 JSON', rawText);
    const cloned = structuredClone(session);
    expect(cloned.roles[0]).not.toBe(source);
    expect(cloned.roles[0]).toStrictEqual(source);
    expect(Object.hasOwn(cloned.roles[0].card.extension as object, 'ownUndefined')).toBe(true);
    await render(cloned);
    expect(form().hidden).toBe(false);
    expect(field('角色卡 JSON').value).toBe(rawText);
    expect(button('收起 JSON 编辑')).toBeDefined();
    expect(button('保存修改').disabled).toBe(false);
    expect(save).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it('keeps unsaved cloud name and description when the same scope receives structurally equal cloned roles', async () => {
    await click('云端');
    expect(cloudField('云端名称').value).toBe(source.name);
    expect(cloudField('简介').value).toBe(source.notes);
    await editControl(cloudField('云端名称'), '尚未提交的云端名称');
    await editControl(cloudField('简介'), '尚未提交的云端简介');
    const cloned = structuredClone(session);
    expect(cloned.roles[0]).not.toBe(source);
    expect(cloned.roles[0]).toStrictEqual(source);
    await render(cloned);
    expect(cloudField('云端名称').value).toBe('尚未提交的云端名称');
    expect(cloudField('简介').value).toBe('尚未提交的云端简介');
    expect(form().hidden).toBe(true);
    expect(save).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it('retains raw-only dirty input and its original source after an external role change and a rejected save', async () => {
    await click('编辑'); await click('编辑角色卡 JSON');
    const raw = { ...source.card, content: '外部变更之前写下的高级稿', future: { draft: true } };
    const rawText = JSON.stringify(raw, null, 2);
    await edit('角色卡 JSON', rawText);
    // No basic input is edited: the host-only dirty signal must pin the source too.
    const external = structuredClone(source);
    external.name = '外部新名称';
    external.notes = '外部新备注';
    external.card = { ...external.card, name: external.name, content: '外部已保存设定', current_state: { summary: '外部新状态' } };
    await render({ ...session, updatedAt: 2, roles: [external, other] });
    expect(button(external.name).getAttribute('aria-pressed')).toBe('true');
    expect(field('角色卡 JSON').value).toBe(rawText);
    expect(field('角色名称').value).toBe(source.name);
    expect(field('角色备注').value).toBe(source.notes);
    expect(field('当前状态摘要').value).toBe('旧状态');
    save.mockResolvedValue(false);
    await click('保存修改');
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toBe(source);
    expect(save.mock.calls[0][0]).not.toBe(external);
    expect(save.mock.calls[0][1]).toMatchObject({ name: source.name, notes: source.notes,
      card: { name: source.name, content: raw.content, current_state: { summary: '旧状态' }, future: raw.future } });
    expect(field('角色卡 JSON').value).toBe(rawText);
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('保存未完成');
    expect(form().querySelector('[role="status"]')).toBeNull();
    expect(button('保存修改').disabled).toBe(false);
    await render({ ...session, updatedAt: 3, roles: [structuredClone(external), other] });
    expect(field('角色卡 JSON').value).toBe(rawText);
    await click('保存修改');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe(source);
    expect(field('角色卡 JSON').value).toBe(rawText);
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('保存未完成');
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['[]', 'null', '12', '"text"', '{'] as const)('retains the advanced JSON entry and rejects non-object/invalid input %s', async text => {
    await click('编辑'); await click('编辑角色卡 JSON');
    expect(field('角色卡 JSON').value).toContain('角色设定');
    await edit('角色卡 JSON', text); await click('保存修改');
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('角色卡 JSON 解析失败');
    expect(field('角色卡 JSON').value).toBe(text);
    expect(save).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(button('保存修改').disabled).toBe(false);
  });

  it('routes valid host-only JSON through the same awaited save while retaining its unknown fields', async () => {
    await click('编辑'); await click('编辑角色卡 JSON');
    const raw = { templateId: '通用角色', name: 'JSON 名称', content: '高级设定',
      current_state: { summary: '旧状态', future: { keep: ['raw'] } }, future: { rawExtension: [1, 2] } };
    await edit('角色卡 JSON', JSON.stringify(raw));
    const receipt = deferred<boolean>(); save.mockReturnValueOnce(receipt.promise);
    await click('保存修改');
    expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0][0]).toBe(source);
    expect(save.mock.calls[0][1].card).toStrictEqual({ ...raw, name: source.name });
    expect(form().querySelector('[role="status"]')).toBeNull();
    await act(async () => receipt.resolve(true));
    expect(form().querySelector('[role="status"]')?.textContent).toContain('已保存到本地会话');
    expect(JSON.parse(field('角色卡 JSON').value)).toStrictEqual({ ...raw, name: source.name });
    expect(update).not.toHaveBeenCalled();
  });
});
