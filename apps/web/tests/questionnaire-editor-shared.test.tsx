// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  cloudData: null as unknown,
  authenticated: false,
  download: vi.fn(),
  clipboard: vi.fn(),
  writeClipboard: vi.fn(),
  reload: vi.fn(),
  cloudSave: vi.fn(),
  cloudApi: {
    getUserCapacity: vi.fn(),
    createCard: vi.fn(),
    replaceCard: vi.fn(),
    replaceOwnedCard: vi.fn(),
    repairQuestionnaireType: vi.fn(),
  },
}));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href}>{children}</a> }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: ({ data }: { data: unknown }) => { mocks.cloudData = data; return <button onClick={mocks.cloudSave}>保存云问卷</button>; } }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/CharManager/DataCardsModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/RecycleBinModal', () => ({ default: () => null }));
vi.mock('@/components/shared/TokenIndicator', () => ({ TokenIndicator: () => null }));
vi.mock('@/components/shared/JsonSizeIndicator', () => ({ JsonSizeIndicator: () => null }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: mocks.authenticated, user: mocks.authenticated ? { id: 7 } : null, identityEpoch: 1 }) }));
vi.mock('@/lib/auth', () => ({ dataCardApi: mocks.cloudApi }));
vi.mock('@/lib/use-data-card-summary-page', () => ({ useDataCardSummaryPage: () => ({ reload: mocks.reload, status: 'idle' }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: vi.fn() }));
import { QuestionnaireEditorPage } from '../components/creation/QuestionnaireEditorPage';
let container: HTMLDivElement; let root: Root;
function region(name: string) {
  const result = [...container.querySelectorAll<HTMLElement>('section, [role="region"]')].find((node) => {
    const labelledBy = node.getAttribute('aria-labelledby');
    const accessibleName = labelledBy
      ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      : node.getAttribute('aria-label');
    return accessibleName === name;
  });
  if (!result) throw new Error(`Missing accessible region: ${name}`);
  return result;
}
function labelledControl(text: string) {
  const label = [...container.querySelectorAll('label')].find((node) => node.textContent === text);
  expect(label, `Missing label: ${text}`).toBeDefined();
  expect(label!.control, `Label does not name its control: ${text}`).not.toBeNull();
  return label!.control as HTMLInputElement | HTMLTextAreaElement;
}
function button(text: string) { const result = [...container.querySelectorAll('button')].find((item) => item.textContent === text); if (!result) throw new Error(text); return result; }
async function click(text: string) { await act(async () => button(text).click()); }
function input(node: HTMLInputElement | HTMLTextAreaElement, text: string) { act(() => { Object.getOwnPropertyDescriptor(node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(node, text); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
const card = (title: string) => ({ id: 'x', kind: 'magical-girl', title, nativeAllowed: true, signature: 'unverified', extra: { keep: true }, questions: [{ id: 'q1', question: '题目', options: [{ label: 'A', value: 'A', extra: true }], displayIf: { questionId: 'q0', questionnaireId: 'scope', value: ['A|B'] } }] });
beforeEach(() => { vi.clearAllMocks(); mocks.authenticated = false; mocks.cloudData = null; mocks.clipboard.mockReset(); mocks.writeClipboard.mockReset().mockResolvedValue(undefined); mocks.cloudApi.getUserCapacity.mockResolvedValue(null); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: mocks.clipboard, writeText: mocks.writeClipboard } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); act(() => root.render(<QuestionnaireEditorPage />)); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
describe('Web questionnaire host uses shared core and real controls', () => {
  it('imports extensions and complex rules through shared controls and retains raw source download', async () => {
    const raw = JSON.stringify(card('源问卷'));
    input(container.querySelector('textarea')!, raw); await click('应用粘贴内容');
    expect(mocks.cloudData).toMatchObject({ title: '源问卷', nativeAllowed: false, extra: { keep: true }, questions: [{ options: [{ extra: true }], displayIf: card('源问卷').questions[0].displayIf }] });
    expect(mocks.cloudData).not.toHaveProperty('signature'); expect(container.textContent).toContain('高级 JSON 中的条件');
    await click('下载原始来源'); expect(mocks.download).toHaveBeenCalledTimes(1);
    const titleLabel = [...container.querySelectorAll('label')].find((node) => node.textContent === '问卷标题')!;
    input(titleLabel.nextElementSibling as HTMLInputElement, '已修改'); expect(mocks.cloudData).toHaveProperty('title', '已修改');
  });
  it('ignores a late clipboard import after newer edits or paste', async () => {
    let resolve!: (text: string) => void; mocks.clipboard.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await click('从剪贴板导入'); input(container.querySelector('textarea')!, JSON.stringify(card('较新来源'))); await click('应用粘贴内容');
    await act(async () => resolve(JSON.stringify(card('过时来源')))); expect(mocks.cloudData).toHaveProperty('title', '较新来源');
  });
  it('ignores a late file read after changing a question', async () => {
    let resolve!: (buffer: ArrayBuffer) => void;
    const file = { size: 100, arrayBuffer: () => new Promise<ArrayBuffer>((done) => { resolve = done; }) };
    const upload = container.querySelector('input[type="file"]')!;
    Object.defineProperty(upload, 'files', { configurable: true, value: [file] }); await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
    const label = [...container.querySelectorAll('label')].find((node) => node.textContent === '题目内容')!;
    input(label.nextElementSibling as HTMLInputElement, '保留最新编辑');
    await act(async () => resolve(new TextEncoder().encode(JSON.stringify(card('旧文件'))).buffer));
    expect(mocks.cloudData).toMatchObject({ questions: [{ question: '保留最新编辑' }] });
  });
});


describe('Web questionnaire transfer workspace accessibility', () => {
  it('exposes named import and export regions around their actions', () => {
    expect(region('导入现有问卷').contains(button('从剪贴板导入'))).toBe(true);
    expect(region('导入现有问卷').contains(button('应用粘贴内容'))).toBe(true);
    expect(region('导出问卷').contains(button('复制 JSON'))).toBe(true);
    expect(region('导出问卷').contains(button('下载 JSON'))).toBe(true);
  });

  it('associates upload and paste labels with the actual import controls', async () => {
    const upload = labelledControl('上传问卷 JSON 文件') as HTMLInputElement;
    expect(upload.type).toBe('file');
    expect(upload.accept).toContain('application/json');
    const paste = labelledControl('粘贴问卷 JSON');
    expect(paste).toBeInstanceOf(HTMLTextAreaElement);
    input(paste, JSON.stringify(card('关联控件导入')));
    await click('应用粘贴内容');
    expect(mocks.cloudData).toHaveProperty('title', '关联控件导入');
  });

  it('starts expanded and exposes the preview disclosure state and controlled content', async () => {
    const toggle = button('收起预览');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const previewId = toggle.getAttribute('aria-controls');
    expect(previewId).toBeTruthy();
    const preview = document.getElementById(previewId!);
    expect(preview).not.toBeNull();
    expect(JSON.parse(preview!.textContent!)).toEqual(mocks.cloudData);
    await click('收起预览');
    expect(button('展开预览').getAttribute('aria-expanded')).toBe('false');
    expect(button('展开预览').getAttribute('aria-controls')).toBe(previewId);
    const collapsedPreview = document.getElementById(previewId!);
    expect(collapsedPreview === null || collapsedPreview.hidden).toBe(true);
    await click('展开预览');
    expect(button('收起预览').getAttribute('aria-expanded')).toBe('true');
    expect(button('收起预览').getAttribute('aria-controls')).toBe(previewId);
    expect(JSON.parse(document.getElementById(previewId!)!.textContent!)).toEqual(mocks.cloudData);
  });
});


function pasteInput() { return container.querySelector<HTMLTextAreaElement>('textarea[placeholder="在此粘贴问卷 JSON"]')!; }
function extraFieldsInput() {
  const label = [...container.querySelectorAll('label')].find((node) => node.textContent === '额外字段 JSON（可选）')!;
  return label.parentElement!.querySelector('textarea')!;
}
async function chooseFile(file: { size: number; arrayBuffer: () => Promise<ArrayBuffer> }) {
  const upload = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(upload, 'files', { configurable: true, value: [file] });
  await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
  return upload;
}
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}
function expectNoCloudWrites() {
  expect(mocks.cloudSave).not.toHaveBeenCalled();
  expect(mocks.cloudApi.createCard).not.toHaveBeenCalled();
  expect(mocks.cloudApi.replaceCard).not.toHaveBeenCalled();
  expect(mocks.cloudApi.replaceOwnedCard).not.toHaveBeenCalled();
  expect(mocks.cloudApi.repairQuestionnaireType).not.toHaveBeenCalled();
}

describe('Web questionnaire transfer host behavior remains unchanged', () => {
  it('keeps empty and invalid paste actions available and reports errors without replacing the editor', async () => {
    const initialData = mocks.cloudData;
    expect(button('应用粘贴内容').disabled).toBe(false);
    await click('应用粘贴内容');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('请先粘贴或上传问卷 JSON');
    input(pasteInput(), '{ invalid JSON');
    await click('应用粘贴内容');
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('请先粘贴或上传问卷 JSON');
    expect(mocks.cloudData).toEqual(initialData);
    expect(pasteInput().value).toBe('{ invalid JSON');
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === '下载原始来源')).toBe(false);
    expectNoCloudWrites();
  });

  it('reports a clipboard read failure and still accepts a later paste import', async () => {
    mocks.clipboard.mockRejectedValueOnce(new Error('剪贴板读取被拒绝'));
    await click('从剪贴板导入');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('剪贴板读取被拒绝');
    input(pasteInput(), JSON.stringify(card('手动粘贴恢复')));
    await click('应用粘贴内容');
    expect(mocks.cloudData).toHaveProperty('title', '手动粘贴恢复');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expectNoCloudWrites();
  });

  it('reports file read failure without replacing the current editor or retaining a failed source', async () => {
    const initialData = mocks.cloudData;
    await chooseFile({ size: 100, arrayBuffer: () => Promise.reject(new Error('文件读取失败')) });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('文件读取失败');
    expect(mocks.cloudData).toEqual(initialData);
    expect(pasteInput().value).toBe('');
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === '下载原始来源')).toBe(false);
    expectNoCloudWrites();
  });

  it('copies normalized JSON and reports write failure without changing the editor', async () => {
    mocks.clipboard.mockResolvedValueOnce(JSON.stringify(card('剪贴板导入')));
    await click('从剪贴板导入');
    expect(mocks.cloudData).toHaveProperty('title', '剪贴板导入');
    await click('复制 JSON');
    const copied = JSON.parse(mocks.writeClipboard.mock.calls[0][0]);
    expect(copied).toEqual(mocks.cloudData);
    expect(copied).toHaveProperty('nativeAllowed', false);
    expect(copied).not.toHaveProperty('signature');
    const beforeFailure = mocks.cloudData;
    mocks.writeClipboard.mockRejectedValueOnce(new Error('write denied'));
    await click('复制 JSON');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('复制失败，请手动选择文本');
    expect(mocks.cloudData).toEqual(beforeFailure);
    expectNoCloudWrites();
  });

  it.each(['复制 JSON', '下载 JSON'])('keeps %s clickable so invalid advanced JSON reports the validation error', async (action) => {
    await click('应用粘贴内容');
    input(extraFieldsInput(), '{ invalid');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('请先粘贴或上传问卷 JSON');
    expect(button(action).disabled).toBe(false);
    await click(action);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('第 1 题的“额外字段 JSON”无法解析');
    expect(mocks.writeClipboard).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expectNoCloudWrites();
  });

  it('auto-imports a BOM file and keeps exact source bytes independently downloadable after edits and validation errors', async () => {
    await act(async () => { mocks.authenticated = true; root.render(<QuestionnaireEditorPage />); });
    const raw = '\uFEFF' + JSON.stringify(card('文件原件'), null, 2) + '\r\n';
    const bytes = new TextEncoder().encode(raw);
    const arrayBuffer = vi.fn().mockResolvedValue(bytes.buffer);
    const upload = await chooseFile({ size: bytes.byteLength, arrayBuffer });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(upload.value).toBe('');
    expect(pasteInput().value).toBe(raw.replace(/\r\n/g, '\n'));
    expect(mocks.cloudData).toMatchObject({ title: '文件原件', nativeAllowed: false, extra: { keep: true } });
    expect(mocks.cloudData).not.toHaveProperty('signature');
    const titleLabel = [...container.querySelectorAll('label')].find((node) => node.textContent === '问卷标题')!;
    input(titleLabel.nextElementSibling as HTMLInputElement, '编辑后的标题');
    await click('下载 JSON');
    const [normalizedBlob, filename] = mocks.download.mock.calls[0] as [Blob, string];
    expect(filename).toBe('编辑后的标题.json');
    expect(JSON.parse(new TextDecoder().decode(await blobBytes(normalizedBlob)))).toEqual(mocks.cloudData);
    input(extraFieldsInput(), '{ invalid');
    await click('清空');
    expect(pasteInput().value).toBe('');
    expect(button('下载原始来源').disabled).toBe(false);
    await click('下载原始来源');
    const [sourceBlob, sourceFilename] = mocks.download.mock.calls[1] as [Blob, string];
    expect(sourceFilename).toBe('问卷原始来源.json');
    expect(sourceBlob.type).toBe('application/json');
    expect(Array.from(await blobBytes(sourceBlob))).toEqual(Array.from(bytes));
    expect([...(await blobBytes(sourceBlob)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(mocks.cloudData).toHaveProperty('title', '编辑后的标题');
    expectNoCloudWrites();
  });

  it.each(['clipboard', 'file'])('ignores a late %s failure after clear', async (source) => {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    if (source === 'clipboard') {
      mocks.clipboard.mockReturnValueOnce(pending);
      await click('从剪贴板导入');
    } else {
      await chooseFile({ size: 100, arrayBuffer: () => pending });
    }
    await click('清空');
    await act(async () => reject(new Error('过时读取失败')));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pasteInput().value).toBe('');
    expect(mocks.cloudData).toHaveProperty('title', '未命名问卷');
    expectNoCloudWrites();
  });

  it.each(['clipboard', 'file'])('does not let a late %s result repopulate cleared paste input or replace the current editor', async (source) => {
    const raw = JSON.stringify(card('已应用问卷'));
    input(pasteInput(), raw);
    await click('应用粘贴内容');
    let resolve!: (text: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    if (source === 'clipboard') {
      mocks.clipboard.mockReturnValueOnce(pending);
      await click('从剪贴板导入');
    } else {
      await chooseFile({ size: 100, arrayBuffer: async () => new TextEncoder().encode(await pending).buffer });
    }
    await click('清空');
    await act(async () => resolve(JSON.stringify(card('过时问卷'))));
    expect(pasteInput().value).toBe('');
    expect(mocks.cloudData).toHaveProperty('title', '已应用问卷');
    await click('下载原始来源');
    expect(Array.from(await blobBytes(mocks.download.mock.calls[0][0] as Blob))).toEqual(Array.from(new TextEncoder().encode(raw)));
    expectNoCloudWrites();
  });
});
