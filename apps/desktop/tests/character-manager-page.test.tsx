// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeLocalLibraryRecord } from '@mahoshojo/local-library/archive-export';
import { deriveLocalDataCardIdV1, digestLocalCardPayloadV1 } from '@mahoshojo/local-library/digest';
import type { LocalCardRecordV1 } from '@mahoshojo/local-library/record';

import { LIST_LOCAL_BACKUPS_COMMAND } from '../src/platform/local-backup-bridge';
import {
  DELETE_LOCAL_CARD_COMMAND,
  GET_LOCAL_CARD_COMMAND,
  LIST_LOCAL_CARDS_COMMAND,
  RESTORE_LOCAL_CARD_COMMAND,
  SAVE_LOCAL_CARD_COMMAND,
} from '../src/platform/local-card-bridge';
import { DESKTOP_CHARACTER_MANAGER_DRAFT_KEY } from '../src/features/character-manager/draft-persistence';
import { createDesktopRouter } from '../src/app/router';
import { resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';

const native = vi.hoisted(() => ({ listen: vi.fn() }));
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: native.listen }) }));
vi.mock('../src/platform/desktop-archive-host', () => ({
  createDesktopArchiveHost: () => ({
    probeStorage: async () => null,
    runExport: vi.fn(),
    pickArchiveBytes: vi.fn(),
    inspectArchive: vi.fn(),
    applyArchive: vi.fn(),
    describeError: () => '归档失败',
  }),
  DESKTOP_LIBRARY_ARCHIVE_LIMITS: { fileBytes: 1024 },
}));

const makeRecord = async (data: Record<string, unknown>, overrides: Partial<LocalCardRecordV1> = {}): Promise<LocalCardRecordV1> => {
  const contentDigest = await digestLocalCardPayloadV1(data);
  return {
    id: deriveLocalDataCardIdV1(contentDigest),
    schemaVersion: 1,
    storageLocation: 'local',
    cardType: 'character',
    title: String(data.codename ?? '卡'),
    data: data as LocalCardRecordV1['data'],
    contentDigest,
    provenance: { kind: 'unsigned', execution: 'direct-local' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
};

let rows: Map<string, LocalCardRecordV1>;
let original: LocalCardRecordV1;
let root: Root;
let container: HTMLDivElement;
let close: (event: { preventDefault: () => void }) => void;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
/** 懒加载路由与 IPC mock 在负载下可能晚于固定等待；按条件轮询而不是赌一个时长。 */
const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await settle();
  }
};
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (target: Element | undefined) => {
  await act(async () => { target!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
};
const questionnaireLink = () => [...container.querySelectorAll<HTMLAnchorElement>('[data-testid="page-character-manager"] a')].find((link) => link.textContent === '创建与调整自定义问卷');
const activateQuestionnaireLink = async (method: 'click' | 'keyboard') => {
  const link = questionnaireLink();
  expect(link).toBeDefined();
  if (!link) throw new Error('缺少指南问卷入口');
  expect(link.getAttribute('href')).toMatch(/#\/questionnaire-editor$/);
  await act(async () => {
    if (method === 'keyboard') {
      link.focus();
      expect(document.activeElement).toBe(link);
      expect(link.tabIndex).toBe(0);
      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    // jsdom 不执行 Enter 的浏览器默认激活；显式模拟其 detail=0 click，仍走真实 Link/Router。
    const activation = new MouseEvent('click', { bubbles: true, cancelable: true, detail: method === 'keyboard' ? 0 : 1 });
    link.dispatchEvent(activation);
    expect(activation.defaultPrevented).toBe(true);
    if (method === 'keyboard') link.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
  await settle();
};
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
});
const fieldByLabel = (label: string) => {
  const target = [...container.querySelectorAll('label')].find((item) => item.textContent?.trim().startsWith(label))!;
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(target.htmlFor)}`)!;
};
/** 共享导入区的粘贴区默认折叠；先展开再取 textarea。 */
const expandPasteArea = async () => {
  await click(button('▶ 展开文本粘贴区域 (手机端推荐)'));
  await waitFor(() => container.querySelector('textarea') !== null);
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  window.localStorage.clear();
  original = await makeRecord({ codename: '星光', appearance: { outfit: '白裙' } });
  rows = new Map([[original.id, original]]);
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'cloud_cached_account') return null;
    if (command === 'cloud_auth_status') return { state: 'signed-out' };
    if (command === LIST_LOCAL_BACKUPS_COMMAND) return { backups: [], invalidCount: 0 };
    if (command === LIST_LOCAL_CARDS_COMMAND) {
      const includeDeleted = (args?.request as { includeDeleted: boolean }).includeDeleted;
      return { documents: [...rows.values()].filter((item) => includeDeleted || item.deletedAt === undefined).map(serializeLocalLibraryRecord) };
    }
    if (command === GET_LOCAL_CARD_COMMAND) {
      const found = rows.get(args?.id as string);
      return found === undefined ? null : serializeLocalLibraryRecord(found);
    }
    if (command === SAVE_LOCAL_CARD_COMMAND || command === DELETE_LOCAL_CARD_COMMAND || command === RESTORE_LOCAL_CARD_COMMAND) {
      const request = args?.request as { document: string; writeMode: string };
      const document = JSON.parse(request.document) as LocalCardRecordV1;
      if (request.writeMode === 'insert-if-absent' && rows.has(document.id)) return { id: document.id, alreadyPresent: true };
      rows.set(document.id, document);
      return { id: document.id };
    }
    return undefined;
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  // 初始 URL 同步设置；避免迟到的 hash pop 在挂载后误命中已恢复草稿的守卫。
  window.history.replaceState(null, '', '#/local-library');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  native.listen.mockImplementation(async (handler) => { close = handler; return vi.fn(); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const mount = async () => {
  const router = createDesktopRouter();
  await router.load();
  await act(async () => { root.render(<RouterProvider router={router} />); });
  await settle();
  return router;
};

/** Desktop 真实入口启用 StrictMode（双挂载 effect），仲裁路径必须幂等。 */
const mountStrict = async () => {
  const router = createDesktopRouter();
  await router.load();
  await act(async () => { root.render(<StrictMode><RouterProvider router={router} /></StrictMode>); });
  await settle();
  return router;
};

/** 预置一份 attached 页面草稿（originalId 指向 `original`）。 */
const seedAttachedDraft = (data: Record<string, unknown> = { codename: '草稿角色', appearance: { outfit: '黑裙' } }) => {
  window.localStorage.setItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    payload: {
      pastedJson: '',
      draft: {
        cardType: 'character',
        title: '草稿标题',
        data,
        originalId: original.id,
        originalData: original.data,
      },
    },
  }));
};

/** 挂起 `GET_LOCAL_CARD_COMMAND`：返回所有挂起点，逐一放行后仲裁才落定。 */
const deferCardGet = () => {
  const pendingGets: Array<() => void> = [];
  const fallback = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === GET_LOCAL_CARD_COMMAND) {
      const found = rows.get(args?.id as string);
      await new Promise<void>((resolve) => { pendingGets.push(resolve); });
      return found === undefined ? null : serializeLocalLibraryRecord(found);
    }
    return fallback(command, args);
  });
  return async () => { await act(async () => { pendingGets.forEach((resolve) => resolve()); }); };
};

const scenarioData = {
  title: '雾港巡夜',
  scenario_type: '调查',
  description: '追查雨夜失踪的灯火',
  _battle_story: { total_chapters: 5, plan_mode: 'suggested' },
  adjudicationEvents: [{
    id: 'harbor:event:1',
    description: '守灯人是否发现归航信号',
    type: 'binary',
    probability: 65,
    outcomes: [
      { id: 'signal-found', name: '找到信号', probability: 60 },
      { id: 'signal-missed', name: '错过信号', probability: 40 },
    ],
  }],
  futureExtension: { keep: ['unknown', 7] },
  elements: {
    scene: { time: '深夜', place: '旧港', features: '浓雾遮住航道' },
    roles: [
      { name: '守灯人', description: '等待归航' },
      { name: '领航员', description: '辨认暗礁' },
    ],
    events: '调查灯塔失火',
    atmosphere: '紧张',
    development: ['追踪脚印', '询问船员'],
  },
};

const mountScenario = async () => {
  const record = await makeRecord(scenarioData, { cardType: 'scenario', title: scenarioData.title });
  rows.set(record.id, record);
  window.history.replaceState(null, '', `#/character-manager?card=${record.id}`);
  const router = await mount();
  await waitFor(() => container.textContent?.includes(`编辑情景: ${scenarioData.title}`) === true);
  return { record, router };
};

const scenarioLabel = (text: string, scope: Element = container) => {
  const labels = [...scope.querySelectorAll('label')].filter((item) => item.textContent?.trim() === text);
  expect(labels, `标签 ${text} 应在当前范围唯一`).toHaveLength(1);
  return labels[0]!;
};

const scenarioField = (text: string, scope: Element = container) => {
  const label = scenarioLabel(text, scope);
  expect(label.htmlFor, `标签 ${text} 应具名关联控件`).not.toBe('');
  const control = label.control;
  expect(control, `标签 ${text} 应关联当前范围中的控件`).not.toBeNull();
  expect(scope.contains(control)).toBe(true);
  expect(document.getElementById(label.htmlFor)).toBe(control);
  return control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
};

const scenarioGroup = (text: string) => {
  const legend = [...container.querySelectorAll('legend')].find((item) => item.textContent?.trim() === text);
  expect(legend, `应存在 ${text} 分组`).toBeDefined();
  return legend!.parentElement as HTMLFieldSetElement;
};

const scenarioText = (text: string, scope: Element = container) => {
  const control = scenarioField(text, scope);
  expect(control.tagName === 'INPUT' || control.tagName === 'TEXTAREA').toBe(true);
  return control as HTMLInputElement | HTMLTextAreaElement;
};

const scenarioRecordData = (record: LocalCardRecordV1) => {
  const data = record.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('保存的情景应是 JSON 对象');
  return data;
};

describe('Desktop 本地角色管理（IPC mock，仍需真机重启验收）', () => {
  it('与 Web 同一产品骨架：品牌 Logo、使用指南、我的数据卡与内容模板入口齐全', async () => {
    window.history.replaceState(null, '', '#/character-manager');
    await mount();
    await waitFor(() => container.querySelector('img[src="/character-manager.svg"]') !== null);
    expect(container.querySelector('img[src="/character-manager-white.svg"]')).not.toBeNull();
    expect(container.textContent).toContain('在这里查看、编辑和维护你的角色档案');
    expect(container.textContent).toContain('使用指南');
    expect(button('我的数据卡')).not.toBeUndefined();
    expect(container.textContent).toContain('内容模板');
    // 空页面没有可持久化的内容：不写「空草稿」，也就不显示「已自动保存」。
    expect(container.textContent).not.toContain('已自动保存');
    expect(window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBeNull();
    expect(questionnaireLink()?.parentElement?.textContent).toBe('问卷编辑器：创建与调整自定义问卷，可导出或保存到本地问卷库。');
    expect(container.textContent).not.toContain('云端问卷数据卡');
    // 未交付能力不渲染入口：立绘、敏感词、原生性徽章均不出现。
    expect(container.textContent).not.toContain('立绘');
    expect(container.textContent).not.toContain('敏感词检测控制台');
    expect(container.textContent).not.toContain('原生数据');
  });

  it.each(['click', 'keyboard'] as const)('空角色管理页经指南 %s 激活进入真实本地问卷编辑器，不创建角色草稿或写库', async (method) => {
    window.history.replaceState(null, '', '#/character-manager');
    const router = await mount();
    await waitFor(() => questionnaireLink() !== undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const authQueries = bridge.invoke.mock.calls.filter(([command]) => command === 'cloud_auth_status').length;
    await activateQuestionnaireLink(method);
    await waitFor(() => button('另存到本地问卷库') !== undefined);
    expect(router.state.location.pathname).toBe('/questionnaire-editor');
    expect(router.state.location.search).toEqual({});
    expect(container.textContent).toContain('本地问卷库');
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="粘贴问卷 JSON"]')?.value).toBe('');
    expect(confirm).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBeNull();
    expect(bridge.invoke.mock.calls.filter(([command]) => command === 'cloud_auth_status')).toHaveLength(authQueries);
    expect(bridge.invoke.mock.calls.some(([command]) => command === SAVE_LOCAL_CARD_COMMAND || command === 'cloud_card_library_request')).toBe(false);
  });

  it('指南离开取消保全角色草稿，确认后无数据跳转；问卷独立保存后 Back 恢复原草稿和保护', async () => {
    const edited = { codename: '草稿角色', appearance: { outfit: '黑裙' }, future: { nested: ['保真', 7] }, signature: 'opaque-evidence' };
    seedAttachedDraft(edited);
    window.history.replaceState(null, '', `#/character-manager?card=${original.id}`);
    const router = await mount();
    await waitFor(() => container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')?.value === '黑裙');
    await type(fieldByLabel('记录标题'), '未保存的新标题');
    const storedPayload = JSON.parse(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)!).payload;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await activateQuestionnaireLink('click');
    expect(confirm).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe('/character-manager');
    expect(router.state.location.search).toEqual({ card: original.id });
    expect(fieldByLabel('记录标题').value).toBe('未保存的新标题');
    expect(container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')?.value).toBe('黑裙');
    expect(JSON.parse(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)!).payload).toEqual(storedPayload);
    expect(rows.get(original.id)).toEqual(original);

    confirm.mockReturnValue(true);
    await activateQuestionnaireLink('keyboard');
    await waitFor(() => button('另存到本地问卷库') !== undefined);
    expect(router.state.location.pathname).toBe('/questionnaire-editor');
    expect(router.state.location.search).toEqual({});
    expect(container.textContent).not.toContain('草稿角色');
    const paste = container.querySelector<HTMLTextAreaElement>('[aria-label="粘贴问卷 JSON"]')!;
    expect(paste.value).toBe('');
    expect(JSON.parse(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)!).payload).toEqual(storedPayload);
    await type(paste, JSON.stringify({ id: 'separate-q', kind: 'magical-girl', title: '独立问卷', nativeAllowed: true, signature: 'not-native', questions: [{ id: 'q1', question: '独立题目' }] }));
    await click(button('应用粘贴内容'));
    await click(button('另存到本地问卷库'));
    await waitFor(() => container.textContent?.includes('已另存为本地未签名问卷') === true);
    const questionnaire = [...rows.values()].find((record) => record.cardType === 'questionnaire')!;
    expect(questionnaire).toMatchObject({ storageLocation: 'local', title: '独立问卷', provenance: { kind: 'unsigned', execution: 'imported' }, data: { nativeAllowed: false } });
    expect(questionnaire.data).not.toHaveProperty('signature');
    expect(questionnaire.data).not.toHaveProperty('codename');
    expect(rows.get(original.id)).toEqual(original);

    confirm.mockClear().mockReturnValue(false);
    await act(async () => { router.history.back(); });
    await waitFor(() => container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')?.value === '黑裙');
    expect(router.state.location.search).toEqual({ card: original.id });
    expect(confirm).not.toHaveBeenCalled();
    expect(fieldByLabel('记录标题').value).toBe('未保存的新标题');
    expect(JSON.parse(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)!).payload).toEqual(storedPayload);
    await activateQuestionnaireLink('keyboard');
    expect(confirm).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe('/character-manager');
  });

  it('本地保存仍在进行时重复激活指南入口不能确认绕过，保存完成后才可进入问卷页', async () => {
    window.history.replaceState(null, '', `#/character-manager?card=${original.id}`);
    const router = await mount();
    await waitFor(() => button('保存到本地库') !== undefined);
    await type(fieldByLabel('记录标题'), '保存中的标题');
    await waitFor(() => !button('保存到本地库')!.disabled);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fallback = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === SAVE_LOCAL_CARD_COMMAND) await pending;
      return fallback(command, args);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click(button('保存到本地库'));
    await waitFor(() => bridge.invoke.mock.calls.some(([command]) => command === SAVE_LOCAL_CARD_COMMAND));
    await activateQuestionnaireLink('click');
    await activateQuestionnaireLink('keyboard');
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/character-manager');
    expect(fieldByLabel('记录标题').value).toBe('保存中的标题');
    expect(rows.get(original.id)).toEqual(original);
    expect(container.textContent).toContain('保存仍在进行');
    await act(async () => { release(); });
    await waitFor(() => container.textContent?.includes('已更新本地库中的记录。') === true);
    expect(rows.get(original.id)?.title).toBe('保存中的标题');
    expect(bridge.invoke.mock.calls.filter(([command]) => command === SAVE_LOCAL_CARD_COMMAND)).toHaveLength(1);
    await activateQuestionnaireLink('click');
    await waitFor(() => button('另存到本地问卷库') !== undefined);
    expect(router.state.location.pathname).toBe('/questionnaire-editor');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('「我的数据卡」打开共享选择器，默认落在本地页签并列出本地记录', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await waitFor(() => button('我的数据卡') !== undefined);
    await click(button('我的数据卡'));
    // 打开选择器是一次主动使用：顺手探测一次会话（DESK-ONLINE-013）。
    await waitFor(() => bridge.invoke.mock.calls.some((call) => call[0] === 'cloud_auth_status'));
    // Modal 内容渲染在页面 DOM 中（非 portal），等待本地列表出现记录标题。
    await waitFor(() => document.body.textContent?.includes('星光') === true);
    expect(document.body.textContent).toContain('本地');
  });

  it('从本地库进入编辑，只改标题时原记录整卡替换，未保存修改受离开保护', async () => {
    const router = await mount();
    await waitFor(() => button('编辑') !== undefined);
    await click(button('编辑'));
    await waitFor(() => container.textContent?.includes('编辑角色: 星光') === true);
    expect(router.state.location.pathname).toBe('/character-manager');
    expect(router.state.location.search).toEqual({ card: original.id });
    expect(container.textContent).toContain('本地库记录');
    // 已有记录的类型创建后不可修改：编辑器里是只读文本而不是下拉选择。
    const typeInput = container.querySelector<HTMLInputElement>(`#${CSS.escape([...container.querySelectorAll('label')].find((item) => item.textContent?.includes('类型（创建后不可修改）'))!.htmlFor)}`)!;
    expect(typeInput.readOnly).toBe(true);

    await type(fieldByLabel('记录标题'), '星光·改');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { void router.navigate({ to: '/settings' }); });
    await settle();
    expect(confirm).toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/character-manager');
    const prevented = vi.fn();
    // 关窗回调会同步写入提示状态（guard message），与真实事件一样需要 act 包裹。
    await act(async () => { close({ preventDefault: prevented }); });
    expect(prevented).toHaveBeenCalledOnce();

    await click(button('保存到本地库'));
    await waitFor(() => container.textContent?.includes('已更新本地库中的记录。') === true);
    expect(rows.get(original.id)?.title).toBe('星光·改');
    expect(rows.size).toBe(1);

    confirm.mockClear();
    await act(async () => { await router.navigate({ to: '/settings' }); });
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('改正文另存为新记录，原记录保留并可显式移入回收站', async () => {
    window.location.hash = `#/character-manager?card=${original.id}`;
    const router = await mount();
    await waitFor(() => container.querySelector('#editor-field-appearance__outfit') !== null);
    await type(container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')!, '黑裙');
    await click(button('保存到本地库'));
    await waitFor(() => container.textContent?.includes('已另存为一条新记录') === true);
    expect(rows.size).toBe(2);
    const created = [...rows.values()].find((item) => item.id !== original.id)!;
    expect(created.provenance).toEqual({ kind: 'unsigned', execution: 'edited' });
    await waitFor(() => router.state.location.search.card === created.id);

    await click(button('将原记录移入回收站'));
    await waitFor(() => container.textContent?.includes('原记录已移入回收站') === true);
    expect(rows.get(original.id)?.deletedAt).toBeDefined();
  });

  it('粘贴导入命中回收站中的同内容卡时需显式恢复', async () => {
    rows.set(original.id, { ...original, deletedAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' });
    window.location.hash = '#/character-manager';
    const router = await mount();
    await expandPasteArea();
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(original.data));
    await click(button('从文本加载数据'));
    expect(container.textContent).toContain('编辑角色: 星光');
    // 尚未首次保存的导入草稿可以选择类型。
    expect(container.textContent).toContain('尚未保存到本地库');
    const typeLabel = [...container.querySelectorAll('label')].find((item) => item.textContent?.trim().startsWith('类型'))!;
    expect(container.querySelector(`#${CSS.escape(typeLabel.htmlFor)}`)?.tagName).toBe('SELECT');
    await click(button('保存到本地库'));
    await waitFor(() => container.textContent?.includes('内容相同的记录在回收站中') === true);
    expect(rows.get(original.id)?.deletedAt).toBeDefined();

    await click(button('从回收站恢复并打开'));
    await waitFor(() => container.textContent?.includes('本地库记录') === true);
    expect(rows.get(original.id)?.deletedAt).toBeUndefined();
    expect(router.state.location.search).toEqual({ card: original.id });
    expect(container.textContent).toContain('编辑角色: 星光');
  });

  it('导出为 JSON 文件走 WebView 下载通道，导出的是草稿内容且不要求先保存', async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const imported = { codename: '导出角色', appearance: { outfit: '白裙' } };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(imported));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑角色: 导出角色') === true);

    await click(button('保存修改并下载'));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    // 文件名按记录标题生成（与共享卡库下载同一口径）。
    const anchor = anchorClick.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('导出角色.json');
    // Blob 里装着的是当前草稿正文，不是已保存记录。
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blob.text())).toEqual(imported);
    expect(rows.size).toBe(1);
  });

  it('复制当前草稿保留扩展和签名证据，失败可重试且不写库；加载其他数据仍有放弃保护', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('剪贴板不可用')).mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const imported = { codename: '复制角色', appearance: { outfit: '白裙' }, signature: 'opaque', future: { entries: [1, '保真'] } };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(imported));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑角色: 复制角色') === true);
    await click(button('复制到剪贴板'));
    expect(container.textContent).toContain('操作失败：剪贴板不可用');
    await click(button('复制到剪贴板'));
    expect(JSON.parse(writeText.mock.calls[1][0])).toEqual(imported);
    expect(button('已复制！')).toBeDefined();
    expect(rows.size).toBe(1);
    expect(container.textContent).toContain('尚未保存到本地库');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await click(button('加载其他数据'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('编辑角色: 复制角色');
    await click(button('加载其他数据'));
    expect(container.textContent).not.toContain('编辑角色: 复制角色');
    await expandPasteArea();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  });

  it.each(['{broken', JSON.stringify({ version: 77, updatedAt: Date.now(), payload: {} })])('保留坏/未来草稿但允许新编辑、复制、本地保存及确认离开：%s', async (raw) => {
    localStorage.setItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY, raw);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.location.hash = '#/character-manager';
    await mount();
    await waitFor(() => container.textContent?.includes('自动保存已暂停') === true);
    await expandPasteArea();
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify({ codename: '新编辑', future: { keep: true } }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const preventPasteLeave = vi.fn();
    close({ preventDefault: preventPasteLeave });
    expect(preventPasteLeave).toHaveBeenCalledOnce();
    await click(button('从文本加载数据'));
    expect(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBe(raw);
    const preventDefault = vi.fn();
    close({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await click(button('复制到剪贴板'));
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({ codename: '新编辑', future: { keep: true } });
    confirm.mockClear().mockReturnValueOnce(false).mockReturnValueOnce(true);
    await click(button('加载其他数据'));
    expect(container.textContent).toContain('编辑角色: 新编辑');
    await click(button('加载其他数据'));
    expect(container.textContent).not.toContain('编辑角色: 新编辑');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBe(raw);
    await expandPasteArea();
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify({ codename: '新编辑' }));
    await click(button('从文本加载数据'));
    await click(button('保存到本地库'));
    await waitFor(() => container.textContent?.includes('已保存到本地库。') === true);
    expect(rows.size).toBe(2);
    expect(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBe(raw);
  });

  it('保留草稿显式清空失败不解除写保护，成功后保留当前编辑并恢复自动保存', async () => {
    const raw = '{keep';
    localStorage.setItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY, raw);
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify({ codename: '新编辑' }));
    await click(button('从文本加载数据'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    await click(button('清空本地草稿'));
    expect(container.textContent).toContain('清空浏览器内草稿失败');
    expect(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBe(raw);
    remove.mockRestore();
    await click(button('清空本地草稿'));
    expect(container.textContent).not.toContain('自动保存已暂停');
    expect(container.textContent).toContain('编辑角色: 新编辑');
    expect(JSON.parse(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)!).payload.draft.data.codename).toBe('新编辑');
  });

  it('非法导入给出原因且不进入编辑', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '[1, 2]');
    await click(button('从文本加载数据'));
    expect(container.textContent).toContain('数据卡必须是一个 JSON 对象。');
    expect(container.textContent).not.toContain('编辑角色:');
  });

  it('粘贴超过 4 MiB 的文本在解析前拒绝且不进入编辑', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const oversized = `{"a":"${'x'.repeat(4 * 1024 * 1024)}"}`;
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, oversized);
    await click(button('从文本加载数据'));
    expect(container.textContent).toContain('内容超过单张数据卡的大小上限（4 MiB）。');
    expect(container.textContent).not.toContain('编辑角色:');
  });

  it('页面草稿自动持久化并在下次访问时恢复', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const imported = { codename: '草稿角色', appearance: { outfit: '白裙' } };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(imported));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    await settle();
    // 草稿已落 localStorage（key 与 Web 同一产品语义）。
    expect(window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).not.toBeNull();

    // 重新挂载整个应用模拟重启：草稿恢复到编辑器。
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = '#/character-manager';
    await mount();
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    expect(container.textContent).toContain('已恢复本地草稿');
    expect(container.textContent).toContain('尚未保存到本地库');
  });

  it('清空本地草稿后重新访问不再恢复', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const imported = { codename: '草稿角色', appearance: { outfit: '白裙' } };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(imported));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    await settle();

    await click(button('清空本地草稿'));
    expect(window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBeNull();
    // 当前编辑内容不因为清空草稿而消失（同 Web 语义：只清持久化副本）。
    expect(container.textContent).toContain('编辑角色: 草稿角色');

    // 真正 remount（模拟重启）：已清空的草稿不得复活。
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = '#/character-manager';
    await mount();
    await waitFor(() => button('我的数据卡') !== undefined);
    await settle();
    expect(container.textContent).not.toContain('编辑角色: 草稿角色');
    expect(container.textContent).not.toContain('已恢复本地草稿');
    expect(window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).toBeNull();
  });

  it('同一 `?card` 刷新恢复未提交修改：恢复后仍 dirty、保留草稿标题且可保存', async () => {
    window.location.hash = `#/character-manager?card=${original.id}`;
    await mount();
    await waitFor(() => container.textContent?.includes('编辑角色: 星光') === true);
    await type(fieldByLabel('记录标题'), '星光·草稿');
    await type(container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')!, '黑裙');
    await waitFor(() => container.textContent?.includes('已自动保存') === true);

    // 模拟刷新：URL 仍是同一条记录的 `?card`——草稿必须恢复而不是被直达清掉。
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = `#/character-manager?card=${original.id}`;
    await mount();
    await waitFor(() => container.textContent?.includes('已恢复本地草稿') === true);
    // baseline 是本地库原记录而不是草稿自身：恢复出的草稿保持 dirty 与离开保护。
    expect(container.textContent).toContain('本地库记录 · 有未保存的修改');
    expect(fieldByLabel('记录标题').value).toBe('星光·草稿');
    expect(container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')!.value).toBe('黑裙');

    const saveButton = button('保存到本地库');
    expect(saveButton).not.toBeUndefined();
    expect(saveButton!.disabled).toBe(false);
    await click(saveButton);
    await waitFor(() => container.textContent?.includes('已另存为一条新记录') === true);
    expect(rows.size).toBe(2);
  });

  it('`?card` 指向不存在的记录时不销毁无关草稿：旧草稿恢复并保留失败原因', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const imported = { codename: '草稿角色', appearance: { outfit: '白裙' } };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(imported));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    await waitFor(() => window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY) !== null);

    // 带着无关草稿以无效 `?card` 重新进入：URL 打不开不能顺手清掉旧草稿。
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = '#/character-manager?card=missing-record-id';
    await mount();
    await waitFor(() => container.textContent?.includes('本地库中没有这张数据卡') === true);
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    expect(container.textContent).toContain('已恢复本地草稿');
    expect(window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)).not.toBeNull();
  });

  it('`?card` 指向其它记录时 URL 显式意图优先，旧草稿由新编辑会话接管', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const imported = { codename: '草稿角色', appearance: { outfit: '白裙' } };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(imported));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    await waitFor(() => window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY) !== null);

    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.location.hash = `#/character-manager?card=${original.id}`;
    await mount();
    await waitFor(() => container.textContent?.includes('编辑角色: 星光') === true);
    // 显式打开的记录正常进入编辑；旧草稿卡被自动保存的新会话状态接管
    // （pastedJson 是独立的暂存字段，不受此约束）。
    expect(container.textContent).toContain('本地库记录');
    await waitFor(() => {
      const raw = window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY);
      if (raw === null) return false;
      const stored = JSON.parse(raw) as { payload?: { draft?: { originalId?: string | null } | null } };
      return stored.payload?.draft?.originalId === original.id;
    });
  });

  it('草稿仲裁在途时不开放工作区入口，迟到的恢复不会覆盖任何新操作', async () => {
    seedAttachedDraft();
    const releaseGets = deferCardGet();
    window.location.hash = '#/character-manager';
    await mount();
    await settle();

    // 仲裁未完成：模板选择、导入、本地卡列表与「我的数据卡」一律不可达，
    // 用户无法在旧草稿落定前开始新操作。
    expect(container.textContent).toContain('正在恢复页面草稿或读取目标数据卡');
    expect(button('我的数据卡')).toBeUndefined();
    expect(button('▶ 展开文本粘贴区域 (手机端推荐)')).toBeUndefined();
    expect(button('编辑')).toBeUndefined();
    expect(container.textContent).not.toContain('内容模板');

    // 仲裁落定后恢复草稿，工作区入口随之开放。
    await releaseGets();
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    expect(container.textContent).toContain('已恢复本地草稿');
    expect(button('我的数据卡')).not.toBeUndefined();
  });

  it('StrictMode 双挂载下仲裁结论仍唯一生效', async () => {
    seedAttachedDraft();
    const releaseGets = deferCardGet();
    window.location.hash = '#/character-manager';
    await mountStrict();
    await settle();
    expect(container.textContent).toContain('正在恢复页面草稿或读取目标数据卡');

    await releaseGets();
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    expect(container.textContent).toContain('已恢复本地草稿');
    expect(fieldByLabel('记录标题').value).toBe('草稿标题');
  });

  it('自动保存写失败时草稿条如实报告，不再声称会自动保存', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    const imported = { codename: '草稿角色', appearance: { outfit: '白裙' } };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(imported));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑角色: 草稿角色') === true);
    await waitFor(() => container.textContent?.includes('已自动保存') === true);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await type(fieldByLabel('记录标题'), '草稿角色·改');
    await waitFor(() => container.textContent?.includes('页面草稿自动保存失败') === true);
    expect(container.textContent).toContain('页面草稿自动保存暂不可用');
    expect(container.textContent).not.toContain('当前输入会自动保存到浏览器');
  });

  it('结构化情景编辑的基本字段和章节规划使用原生具名标签关联', async () => {
    await mountScenario();
    const fields = [
      ['情景标题', 'INPUT', '雾港巡夜'],
      ['情景类型', 'INPUT', '调查'],
      ['简短描述', 'TEXTAREA', '追查雨夜失踪的灯火'],
      ['时间', 'INPUT', '深夜'],
      ['地点', 'INPUT', '旧港'],
      ['环境特征', 'TEXTAREA', '浓雾遮住航道'],
      ['核心事件', 'TEXTAREA', '调查灯塔失火'],
      ['氛围', 'INPUT', '紧张'],
      ['总章节数', 'INPUT', '5'],
      ['规划模式', 'SELECT', 'suggested'],
    ] as const;
    const controls = fields.map(([text, tagName, value]) => {
      const control = scenarioField(text);
      expect(control.tagName).toBe(tagName);
      expect(control.value).toBe(value);
      act(() => { control.focus(); });
      expect(document.activeElement).toBe(control);
      return control;
    });
    expect(new Set(controls.map((control) => control.id)).size).toBe(fields.length);
    expect(bridge.invoke.mock.calls.some(([command]) => command === SAVE_LOCAL_CARD_COMMAND)).toBe(false);
  });

  it('结构化情景删除和新增动态行后标签仍关联当前项，编辑由真实保存 IPC 持久化', async () => {
    const { record, router } = await mountScenario();
    const originalData = JSON.parse(JSON.stringify(record.data));
    const roles = () => [...scenarioGroup('NPC角色').querySelectorAll('input')].map((input) => input.parentElement!.parentElement!);
    expect(roles()).toHaveLength(2);
    expect(scenarioField('角色名称', roles()[0]).value).toBe('守灯人');
    expect(scenarioField('角色描述', roles()[0]).value).toBe('等待归航');
    expect(scenarioField('角色名称', roles()[1]).value).toBe('领航员');
    expect(scenarioField('角色描述', roles()[1]).value).toBe('辨认暗礁');

    await click(roles()[0]!.parentElement!.querySelector('button')!);
    expect(roles()).toHaveLength(1);
    expect(scenarioField('角色名称', roles()[0]).value).toBe('领航员');
    expect(scenarioField('角色描述', roles()[0]).value).toBe('辨认暗礁');
    await click(button('+ 添加NPC角色'));
    expect(roles()).toHaveLength(2);
    expect(scenarioField('角色名称', roles()[1]).value).toBe('');
    expect(scenarioField('角色描述', roles()[1]).value).toBe('');
    await type(scenarioText('角色名称', roles()[0]), '老领航员');
    await type(scenarioText('角色描述', roles()[0]), '保留第二位角色并更新线索');
    await type(scenarioText('角色名称', roles()[1]), '邮差');
    await type(scenarioText('角色描述', roles()[1]), '携带新的航海图');

    expect(scenarioField('发展方向 1').value).toBe('追踪脚印');
    expect(scenarioField('发展方向 2').value).toBe('询问船员');
    await click(scenarioField('发展方向 1').parentElement!.querySelector('button')!);
    expect(scenarioField('发展方向 1').value).toBe('询问船员');
    expect([...container.querySelectorAll('label')].some((label) => label.textContent === '发展方向 2')).toBe(false);
    await click(button('+ 添加发展方向'));
    expect(scenarioField('发展方向 2').value).toBe('');
    await type(scenarioText('发展方向 1'), '继续询问船员');
    await type(scenarioText('发展方向 2'), '寻找航海图');
    const dynamicControls = [
      ...roles().flatMap((row) => [scenarioField('角色名称', row), scenarioField('角色描述', row)]),
      scenarioField('发展方向 1'), scenarioField('发展方向 2'),
    ];
    expect(new Set(dynamicControls.map((control) => control.id)).size).toBe(dynamicControls.length);

    await type(scenarioText('情景标题'), '雾港寻光');
    await type(scenarioText('情景类型'), '探索');
    await type(scenarioText('简短描述'), '寻找失落的航海图');
    await type(scenarioText('时间'), '黎明');
    await type(scenarioText('地点'), '灯塔');
    await type(scenarioText('环境特征'), '海雾渐散');
    await type(scenarioText('核心事件'), '重新点亮灯塔');
    await type(scenarioText('氛围'), '希望');
    await type(scenarioText('总章节数'), '7');
    const mode = scenarioField('规划模式');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(mode, 'fixed');
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button('保存到本地库'));
    await waitFor(() => container.textContent?.includes('已另存为一条新记录') === true);
    const created = [...rows.values()].find((item) => item.id !== record.id && item.cardType === 'scenario')!;
    expect(created.data).toEqual({
      ...originalData,
      title: '雾港寻光', scenario_type: '探索', description: '寻找失落的航海图',
      _battle_story: { total_chapters: 7, plan_mode: 'fixed' },
      elements: {
        scene: { time: '黎明', place: '灯塔', features: '海雾渐散' },
        roles: [
          { name: '老领航员', description: '保留第二位角色并更新线索' },
          { name: '邮差', description: '携带新的航海图' },
        ],
        events: '重新点亮灯塔', atmosphere: '希望', development: ['继续询问船员', '寻找航海图'],
      },
    });
    expect(rows.get(record.id)?.data).toEqual(originalData);
    expect(bridge.invoke.mock.calls.filter(([command]) => command === SAVE_LOCAL_CARD_COMMAND)).toHaveLength(1);
    await waitFor(() => router.state.location.search.card === created.id);
  });

  it('结构化情景内嵌判定器标签可原生激活并经真实保存保留事件和结果标识', async () => {
    const { record } = await mountScenario();
    const description = scenarioText('事件描述');
    expect(description.value).toBe('守灯人是否发现归航信号');
    await type(description, '领航员能否辨认归航信号');
    const range = scenarioText('成功率:') as HTMLInputElement;
    const number = scenarioText('成功率数值') as HTMLInputElement;
    expect(range.type).toBe('range');
    expect(number.type).toBe('number');
    expect(range.value).toBe('65');
    expect(number.value).toBe('65');
    await type(range, '70');
    expect(scenarioField('成功率数值').value).toBe('70');
    await type(number, '75');
    expect(scenarioField('成功率:').value).toBe('75');
    // jsdom 的 label.click() 验证原生激活；焦点单独调用 focus，不推断浏览器默认焦点行为。
    const custom = scenarioField('自定义结果') as HTMLInputElement;
    const binary = scenarioField('成功/失败') as HTMLInputElement;
    expect(binary.checked).toBe(true);
    act(() => { scenarioLabel('自定义结果').click(); });
    expect(custom.checked).toBe(true);
    expect(binary.checked).toBe(false);
    act(() => { custom.focus(); });
    expect(document.activeElement).toBe(custom);
    const outcomes = () => [...scenarioGroup('🎲 内嵌随机事件').querySelectorAll('input[placeholder="结果名称"]')].map((input) => input.parentElement!);
    expect(outcomes()).toHaveLength(2);
    expect(scenarioField('结果名称', outcomes()[0]).value).toBe('找到信号');
    expect(scenarioField('结果概率', outcomes()[0]).value).toBe('60');
    expect(scenarioField('结果名称', outcomes()[1]).value).toBe('错过信号');
    expect(scenarioField('结果概率', outcomes()[1]).value).toBe('40');
    await type(scenarioText('结果名称', outcomes()[0]), '找到航标');
    await type(scenarioText('结果概率', outcomes()[0]), '30');
    expect(scenarioField('结果概率', outcomes()[1]).value).toBe('70');
    act(() => { scenarioLabel('成功/失败').click(); });
    expect(binary.checked).toBe(true);
    expect(custom.checked).toBe(false);
    expect(scenarioField('成功率数值').value).toBe('75');
    act(() => { scenarioLabel('自定义结果').click(); });
    expect(scenarioField('结果名称', outcomes()[0]).value).toBe('找到航标');
    expect(scenarioField('结果概率', outcomes()[0]).value).toBe('30');
    await click(button('保存到本地库'));
    await waitFor(() => container.textContent?.includes('已另存为一条新记录') === true);
    const created = [...rows.values()].find((item) => item.id !== record.id && item.cardType === 'scenario')!;
    expect(scenarioRecordData(created).adjudicationEvents).toEqual([{
      id: 'harbor:event:1', description: '领航员能否辨认归航信号', type: 'custom', probability: 75,
      outcomes: [
        { id: 'signal-found', name: '找到航标', probability: 30 },
        { id: 'signal-missed', name: '错过信号', probability: 70 },
      ],
    }]);
    expect(scenarioRecordData(created).futureExtension).toEqual(scenarioData.futureExtension);
    expect(rows.get(record.id)?.data).toEqual(scenarioData);
    expect(bridge.invoke.mock.calls.filter(([command]) => command === SAVE_LOCAL_CARD_COMMAND)).toHaveLength(1);
  });

  it('结构化情景遵守本地保存的既有边界：模板禁用，具名正文控件仍可编辑', async () => {
    const { record } = await mountScenario();
    await type(scenarioText('情景标题'), '提交中的情景');
    const fallback = bridge.invoke.getMockImplementation()!;
    let release!: () => void;
    bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === SAVE_LOCAL_CARD_COMMAND) await new Promise<void>((resolve) => { release = resolve; });
      return fallback(command, args);
    });
    await click(button('保存到本地库'));
    await waitFor(() => release !== undefined);
    try {
      expect(container.querySelector('fieldset select')!.matches(':disabled')).toBe(true);
      expect(button('我的数据卡')).toBeUndefined();
      for (const label of ['情景标题', '简短描述', '总章节数', '规划模式', '发展方向 1', '事件描述', '成功/失败']) {
        expect(scenarioField(label).matches(':disabled'), `${label} 不应被本地保存禁用`).toBe(false);
      }
      await type(scenarioText('情景标题'), '保存期间继续编辑');
    } finally {
      await act(async () => { release(); });
    }
    await waitFor(() => button('保存到本地库')?.disabled === false);
    expect(scenarioField('情景标题').value).toBe('保存期间继续编辑');
    const created = [...rows.values()].find((item) => item.id !== record.id && item.cardType === 'scenario')!;
    expect(scenarioRecordData(created).title).toBe('提交中的情景');
    expect(rows.get(record.id)?.data).toEqual(scenarioData);
  });

  it('结构化情景在真实云写期间继承 owner fieldset 禁用，失败后具名控件恢复可用', async () => {
    resetDesktopCloudSessionStoreForTests();
    const fallback = bridge.invoke.getMockImplementation()!;
    const account = { userId: 7, username: 'tester' };
    const sessionExpiresAt = '2026-12-31T00:00:00.000Z';
    let release!: (response: unknown) => void;
    bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'cloud_cached_account') return { account, sessionExpiresAt };
      if (command === 'cloud_auth_status') return { state: 'active', account, sessionExpiresAt };
      if (command === 'cloud_card_library_request') {
        const request = args?.request as { routeId: string };
        if (request.routeId === 'user-capacity.query') return { status: 200, body: { success: true, capacity: 20, usedSlots: 1 } };
        if (request.routeId === 'data-cards.create') return await new Promise((resolve) => { release = resolve; });
        return { status: 200, body: { success: true, items: {} } };
      }
      return fallback(command, args);
    });
    try {
      const { record } = await mountScenario();
      await waitFor(() => button('保存到云端')?.disabled === false);
      await click(button('保存到云端'));
      await waitFor(() => document.querySelector('[role="dialog"]') !== null);
      const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent?.trim() === '保存')!;
      await click(save);
      await waitFor(() => release !== undefined);
      try {
        const controls = [
          '情景标题', '情景类型', '简短描述', '时间', '地点', '环境特征', '核心事件', '氛围',
          '总章节数', '规划模式', '发展方向 1', '发展方向 2', '事件描述', '成功率:', '成功率数值',
          '成功/失败', '自定义结果',
        ].map((text) => scenarioField(text));
        for (const label of scenarioGroup('NPC角色').querySelectorAll('label')) {
          expect(label.control).not.toBeNull();
          controls.push(label.control as HTMLInputElement | HTMLTextAreaElement);
        }
        controls.forEach((control) => expect(control.matches(':disabled'), `${control.id} 应继承 owner 禁用`).toBe(true));
        act(() => { scenarioLabel('自定义结果').click(); });
        expect((scenarioField('成功/失败') as HTMLInputElement).checked).toBe(true);
        expect((scenarioField('自定义结果') as HTMLInputElement).checked).toBe(false);
        expect(rows.get(record.id)?.data).toEqual(scenarioData);
        expect(bridge.invoke.mock.calls.filter(([command]) => command === SAVE_LOCAL_CARD_COMMAND)).toHaveLength(0);
      } finally {
        await act(async () => { release({ status: 400, body: { error: '容量不足' } }); });
      }
      await waitFor(() => document.body.textContent?.includes('容量不足') === true);
      expect(scenarioField('情景标题').matches(':disabled')).toBe(false);
      expect(scenarioField('规划模式').matches(':disabled')).toBe(false);
      expect(scenarioField('自定义结果').matches(':disabled')).toBe(false);
      expect(scenarioField('情景标题').value).toBe(scenarioData.title);
    } finally {
      resetDesktopCloudSessionStoreForTests();
    }
  });

  it('结构化情景卡导入归类为 scenario，跨类别模板转换脱离原记录', async () => {
    window.location.hash = '#/character-manager';
    await mount();
    await expandPasteArea();
    // `elements` 是对象而非数组——按正文特征（`inferDataCardTemplate`）判为情景。
    const scenarioCard = { title: '雾港', elements: { scene: { time: '夜' } }, description: '雨夜' };
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify(scenarioCard));
    await click(button('从文本加载数据'));
    await waitFor(() => container.textContent?.includes('编辑情景: 雾港') === true);
    const typeLabel = [...container.querySelectorAll('label')].find((item) => item.textContent?.trim().startsWith('类型'))!;
    expect(container.querySelector<HTMLSelectElement>(`#${CSS.escape(typeLabel.htmlFor)}`)?.value).toBe('scenario');

    // 已有记录跨类别转换（character → scenario）：脱离原记录成为新的未保存草稿。
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    window.location.hash = `#/character-manager?card=${original.id}`;
    await mount();
    await waitFor(() => container.textContent?.includes('编辑角色: 星光') === true);

    const templateLabel = [...container.querySelectorAll('label')].find((item) => item.textContent?.trim().startsWith('内容模板'))!;
    const templateSelect = templateLabel.parentElement!.querySelector('select')!;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(templateSelect), 'value')!.set!;
    await act(async () => {
      setter.call(templateSelect, 'scenario');
      templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(container.textContent).toContain('已转换为目标模板');
    expect(container.textContent).toContain('脱离原本地库记录');
    expect(container.textContent).toContain('尚未保存到本地库');

    // 保存写入一条新 scenario 记录；原记录不被原地重分类。
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click(button('保存到本地库'));
    await waitFor(() => container.textContent?.includes('已保存到本地库') === true);
    expect(rows.size).toBe(2);
    expect(rows.get(original.id)?.cardType).toBe('character');
    const created = [...rows.values()].find((item) => item.id !== original.id)!;
    expect(created.cardType).toBe('scenario');
    confirm.mockRestore();
  });
});


it('shows the complete magical-girl preview outside the editor without changing the local record', async () => {
  const data = { codename: '蓝铃', appearance: { colorScheme: '蓝色' }, magicConstruct: {}, wonderlandRule: {}, blooming: {}, analysis: {} };
  const record = await makeRecord(data);
  rows.set(record.id, record);
  const router = await mount();
  await act(async () => { await router.navigate({ to: '/character-manager', search: { card: record.id } }); });
  await waitFor(() => container.querySelector('section[aria-label="角色卡片预览"] .result-card') !== null);
  const preview = container.querySelector('section[aria-label="角色卡片预览"]')!;
  expect(preview.querySelector('img[src="/questionnaire-title.svg"]')).not.toBeNull();
  expect(preview.querySelector<HTMLElement>('.result-card')!.style.background).toContain('linear-gradient');
  expect(container.querySelector('.container > .card')!.contains(preview)).toBe(false);
  expect(rows.get(record.id)?.data).toEqual(data);
  expect(bridge.invoke.mock.calls.filter(([command]) => command === SAVE_LOCAL_CARD_COMMAND)).toHaveLength(0);
});


it.each([{ summary: 1 }, { summary: '摘要', fields: [null] }])('keeps malformed optional metadata editable when showing a complete preview %j', async (currentState) => {
  const data = { codename: '待修复', appearance: {}, magicConstruct: {}, wonderlandRule: {}, blooming: {}, analysis: {}, current_state: currentState, arena_history: { entries: [null, { id: 1, title: '合法旧记录', type: 'classic', impact: '正文' }] } };
  const snapshot = JSON.stringify(data);
  const record = await makeRecord(data);
  rows.set(record.id, record);
  const router = await mount();
  await act(async () => { await router.navigate({ to: '/character-manager', search: { card: record.id } }); });
  await waitFor(() => container.querySelector('section[aria-label="角色卡片预览"] .result-card') !== null);
  const preview = container.querySelector('section[aria-label="角色卡片预览"]')!;
  expect(preview.textContent).toContain('当前状态格式暂不支持预览');
  const history = [...preview.querySelectorAll('button')].find((item) => item.textContent?.includes('历战记录'))!;
  await click(history);
  expect(preview.textContent).toContain('合法旧记录');
  expect(preview.textContent).toContain('1 条历战记录格式暂不支持预览');
  expect(JSON.stringify(rows.get(record.id)?.data)).toBe(snapshot);
  expect(bridge.invoke.mock.calls.filter(([command]) => command === SAVE_LOCAL_CARD_COMMAND)).toHaveLength(0);
});

it('保存成功不覆盖在途期间的新正文', async () => {
  window.location.hash = `#/character-manager?card=${original.id}`;
  const router = await mount();
  await waitFor(() => container.querySelector('#editor-field-appearance__outfit') !== null);
  const getsBeforeSave = bridge.invoke.mock.calls.filter(([command]) => command === GET_LOCAL_CARD_COMMAND).length;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await type(container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')!, '黑裙');
  const fallback = bridge.invoke.getMockImplementation()!;
  let release: (() => void) | undefined;
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === SAVE_LOCAL_CARD_COMMAND) await new Promise<void>((resolve) => { release = resolve; });
    return fallback(command, args);
  });
  await click(button('保存到本地库'));
  await waitFor(() => release !== undefined);
  const field = container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')!;
  expect(field.disabled).toBe(false);
  await type(field, '保存期间新输入的红裙');
  expect(field.value).toBe('保存期间新输入的红裙');
  await act(async () => { release!(); });
  await waitFor(() => button('保存到本地库') !== undefined);
  expect(container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')!.value).toBe('保存期间新输入的红裙');
  expect(button('保存到本地库')!.disabled).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  expect(router.state.location.search.card).not.toBe(original.id);
  expect(bridge.invoke.mock.calls.filter(([command]) => command === GET_LOCAL_CARD_COMMAND)).toHaveLength(getsBeforeSave);
  expect(JSON.parse(window.localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)!).payload.draft.data.appearance.outfit).toBe('保存期间新输入的红裙');
});

it('没有旧草稿的初始 URL 读取落定前不开放编辑入口', async () => {
  const release = deferCardGet();
  window.location.hash = `#/character-manager?card=${original.id}`;
  await mount();
  await waitFor(() => bridge.invoke.mock.calls.some(([command]) => command === GET_LOCAL_CARD_COMMAND));
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).not.toContain('内容模板');
  expect(button('我的数据卡')).toBeUndefined();
  await release();
  await waitFor(() => container.querySelector('#editor-field-appearance__outfit') !== null);
});

it('初始 URL 迟到读取不覆盖新导入', async () => {
  const release = deferCardGet();
  window.location.hash = `#/character-manager?card=${original.id}`;
  await mount();
  await waitFor(() => bridge.invoke.mock.calls.some(([command]) => command === GET_LOCAL_CARD_COMMAND));
  const exposed = button('▶ 展开文本粘贴区域 (手机端推荐)') !== undefined;
  if (exposed) {
    await expandPasteArea();
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, JSON.stringify({ codename: '刚导入的新角色' }));
    await click(button('从文本加载数据'));
    expect(container.textContent).toContain('编辑角色: 刚导入的新角色');
  }
  await release();
  await settle();
  expect(container.textContent).toContain(exposed ? '编辑角色: 刚导入的新角色' : '编辑角色: 星光');
});

it('尚未载入的粘贴内容在 quota 写失败后仍受离开保护', async () => {
  window.location.hash = '#/character-manager';
  await mount();
  await expandPasteArea();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '{"codename":"仅在内存"}');
  await waitFor(() => container.textContent?.includes('页面草稿自动保存失败') === true);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const prevented = vi.fn();
  await act(async () => { close({ preventDefault: prevented }); });
  expect(confirm).toHaveBeenCalledOnce();
  expect(prevented).toHaveBeenCalledOnce();
});

it.each(['success', 'failure'] as const)('保存%s后保留在途期间的新标题，并保持离开保护', async (ending) => {
  window.location.hash = `#/character-manager?card=${original.id}`;
  const router = await mount();
  await waitFor(() => container.querySelector('#editor-field-appearance__outfit') !== null);
  await type(fieldByLabel('记录标题'), '提交时标题');
  const fallback = bridge.invoke.getMockImplementation()!;
  let release!: () => void;
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === SAVE_LOCAL_CARD_COMMAND) {
      await new Promise<void>((resolve, reject) => { release = () => ending === 'success' ? resolve() : reject(new Error('disk')); });
    }
    return fallback(command, args);
  });
  await click(button('保存到本地库'));
  await waitFor(() => release !== undefined);
  expect(container.querySelector('fieldset select')!.matches(':disabled')).toBe(true);
  expect(button('我的数据卡')).toBeUndefined();
  await type(fieldByLabel('记录标题'), '保存期间的新标题');
  await act(async () => release());
  await waitFor(() => button('保存到本地库') !== undefined);
  expect(fieldByLabel('记录标题').value).toBe('保存期间的新标题');
  expect(rows.get(original.id)!.title).toBe(ending === 'success' ? '提交时标题' : '星光');
  expect(button('保存到本地库')!.disabled).toBe(false);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => { void router.navigate({ to: '/' }); });
  await settle();
  expect(confirm).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe('/character-manager');
});

it('取消在途 URL 读取后新导入不被迟到响应覆盖', async () => {
  const release = deferCardGet();
  window.location.hash = `#/character-manager?card=${original.id}`;
  const router = await mount();
  await waitFor(() => bridge.invoke.mock.calls.some(([command]) => command === GET_LOCAL_CARD_COMMAND));
  await act(async () => { await router.navigate({ to: '/character-manager', search: {} }); });
  await waitFor(() => button('▶ 展开文本粘贴区域 (手机端推荐)') !== undefined);
  await expandPasteArea();
  await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '{"codename":"新导入"}');
  await click(button('从文本加载数据'));
  await release();
  await settle();
  expect(container.textContent).toContain('编辑角色: 新导入');
  expect(JSON.parse(localStorage.getItem(DESKTOP_CHARACTER_MANAGER_DRAFT_KEY)!).payload.draft.data.codename).toBe('新导入');
});

it('没有旧草稿的目标卡读取失败后重新开放导入入口', async () => {
  window.location.hash = '#/character-manager?card=missing';
  await mountStrict();
  await waitFor(() => container.textContent?.includes('本地库中没有这张数据卡') === true);
  expect(button('我的数据卡')).toBeDefined();
  await expandPasteArea();
  await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '{"codename":"失败后新输入"}');
  await click(button('从文本加载数据'));
  expect(container.textContent).toContain('编辑角色: 失败后新输入');
});

it('保存期间拒绝确认离开，强制卸载后的保存回调不导航回编辑页', async () => {
  window.location.hash = `#/character-manager?card=${original.id}`;
  const router = await mount();
  await waitFor(() => container.querySelector('#editor-field-appearance__outfit') !== null);
  await type(container.querySelector<HTMLInputElement>('#editor-field-appearance__outfit')!, '黑裙');
  const fallback = bridge.invoke.getMockImplementation()!;
  let release!: () => void;
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === SAVE_LOCAL_CARD_COMMAND) await new Promise<void>((resolve) => { release = resolve; });
    return fallback(command, args);
  });
  await click(button('保存到本地库'));
  await waitFor(() => release !== undefined);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => { void router.navigate({ to: '/' }); });
  await settle();
  expect(router.state.location.pathname).toBe('/character-manager');
  const prevented = vi.fn();
  await act(async () => close({ preventDefault: prevented }));
  expect(prevented).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
  const navigate = vi.spyOn(router, 'navigate');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => release());
  await settle();
  expect(navigate).not.toHaveBeenCalled();
});

it('独审：清空失败存档后仍应保护内存中的粘贴内容', async () => {
  window.location.hash = '#/character-manager';
  await mount();
  await expandPasteArea();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '{"codename":"仅在内存"}');
  await waitFor(() => container.textContent?.includes('页面草稿自动保存失败') === true);
  await click(button('清空本地草稿'));
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const prevented = vi.fn();
  await act(async () => { close({ preventDefault: prevented }); });
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('{"codename":"仅在内存"}');
  expect(prevented).toHaveBeenCalledOnce();
});

it('独审：较旧文件读取返回时不得覆盖用户已载入的新内容', async () => {
  window.location.hash = '#/character-manager';
  await mount();
  await waitFor(() => container.querySelector('input[type="file"]') !== null);
  let release!: (text: string) => void;
  const file = new File(['{}'], 'old.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => new Promise<string>(r => { release = r; }) });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await expandPasteArea();
  await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '{"codename":"用户已载入的新内容"}');
  await click(button('从文本加载数据'));
  expect(container.textContent).toContain('编辑角色: 用户已载入的新内容');
  await act(async () => release('{"codename":"旧文件"}'));
  expect(container.textContent).toContain('编辑角色: 用户已载入的新内容');
});

it.each(['success', 'failure'] as const)('较旧文件读取%s在新文件加载后不覆盖内容或诊断', async (ending) => {
  window.location.hash = '#/character-manager';
  await mount();
  await waitFor(() => container.querySelector('input[type="file"]') !== null);
  let release!: (text: string) => void;
  let reject!: (cause: Error) => void;
  const oldFile = new File(['{}'], 'old.json');
  Object.defineProperty(oldFile, 'text', { value: () => new Promise<string>((resolve, fail) => { release = resolve; reject = fail; }) });
  const newFile = new File(['{}'], 'new.json');
  Object.defineProperty(newFile, 'text', { value: async () => '{"codename":"新文件"}' });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [oldFile] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  Object.defineProperty(input, 'files', { configurable: true, value: [newFile] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(container.textContent).toContain('编辑角色: 新文件');
  await act(async () => ending === 'success' ? release('{"codename":"旧文件"}') : reject(new Error('late read')));
  expect(container.textContent).toContain('编辑角色: 新文件');
  expect(container.textContent).not.toContain('读取文件失败');
});

it('尚未载入的新粘贴输入会作废旧文件读取', async () => {
  window.location.hash = '#/character-manager';
  await mount();
  let release!: (text: string) => void;
  const file = new File(['{}'], 'old.json');
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((resolve) => { release = resolve; }) });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await expandPasteArea();
  await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '{"codename":"尚未载入的新内容"}');
  await act(async () => release('{"codename":"旧文件"}'));
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('{"codename":"尚未载入的新内容"}');
  expect(container.textContent).not.toContain('编辑角色: 旧文件');
});
