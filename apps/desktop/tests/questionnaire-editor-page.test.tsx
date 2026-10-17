// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopQuestionnaireEditor } from '../src/app/questionnaire-editor-page';
import type { LocalCardRecordV1 } from '@mahoshojo/local-library/record';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), navigate: vi.fn(), blocker: (() => false) as () => boolean, close: ((_event: { preventDefault: () => void }) => {}) as (event: { preventDefault: () => void }) => void }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async (handler: typeof mocks.close) => { mocks.close = handler; return () => {}; } }) }));
vi.mock('@tanstack/react-router', () => ({ useBlocker: ({ shouldBlockFn }: { shouldBlockFn: () => boolean }) => { mocks.blocker = shouldBlockFn; }, useRouter: () => ({ navigate: mocks.navigate }), Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => <a href={`#${to}`} className={className}>{children}</a> }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openFixed: vi.fn() }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Desktop questionnaire editor real host wiring', () => {
  it('exposes named import and export regions before the editor with an operable JSON preview', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const namedSection = (name: string) => {
      const section = [...container.querySelectorAll('section')].find((node) => {
        const labelledBy = node.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(' ');
        return (node.getAttribute('aria-label') || labelledBy) === name;
      });
      expect(section, `accessible region: ${name}`).toBeDefined();
      return section!;
    };
    const button = (name: string) => [...container.querySelectorAll('button')].find((node) => node.textContent === name)!;
    try {
      await act(async () => root.render(<DesktopQuestionnaireEditor />));
      const imports = namedSection('导入现有问卷');
      const exports = namedSection('导出问卷');
      const title = [...container.querySelectorAll('label')].find((node) => node.textContent === '问卷标题')!;
      expect(imports.querySelector('[aria-label="粘贴问卷 JSON"]')).not.toBeNull();
      expect(imports.contains(button('应用粘贴内容'))).toBe(true);
      expect(exports.contains(button('下载编辑 JSON'))).toBe(true);
      expect(imports.compareDocumentPosition(exports) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(exports.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(container.textContent).toContain('创建指引');
      expect(container.textContent).toContain('optionsFrom');
      expect(container.textContent).toContain('suggestionsFrom');
      expect([...imports.querySelectorAll('button')].some((node) => node.textContent === '从剪贴板导入')).toBe(false);
      expect([...imports.querySelectorAll('button')].some((node) => node.textContent === '清空')).toBe(false);
      expect([...exports.querySelectorAll('button')].some((node) => node.textContent === '复制 JSON')).toBe(false);
      const toggle = button('收起预览');
      expect(exports.contains(toggle)).toBe(true);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const previewId = toggle.getAttribute('aria-controls');
      expect(previewId).toBeTruthy();
      const preview = document.getElementById(previewId!)!;
      expect(exports.contains(preview)).toBe(true);
      expect(JSON.parse(preview.textContent!).title).toBe('未命名问卷');
      await act(async () => toggle.click());
      expect(button('展开预览').getAttribute('aria-expanded')).toBe('false');
      const collapsed = document.getElementById(previewId!);
      expect(collapsed === null || collapsed.hidden).toBe(true);
      await act(async () => button('展开预览').click());
      expect(button('收起预览').getAttribute('aria-controls')).toBe(previewId);
      expect(JSON.parse(document.getElementById(previewId!)!.textContent!).title).toBe('未命名问卷');
    } finally { act(() => root.unmount()); container.remove(); }
  });
  it('saves via existing IPC insert-if-absent with unsigned provenance and downloads exact result', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob); vi.useFakeTimers();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const create = vi.fn((_blob: NodeBlob) => 'blob:questionnaire');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let saved: LocalCardRecordV1 | undefined;
    mocks.invoke.mockImplementation(async (command: string, args: { request?: { writeMode: string; document: string } }) => {
      if (command !== 'save_local_card') throw new Error(`Unexpected IPC ${command}`);
      expect(args.request?.writeMode).toBe('insert-if-absent');
      saved = JSON.parse(args.request!.document);
      return { id: saved!.id, alreadyPresent: false };
    });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const button = (name: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === name)!;
    try {
      await act(async () => root.render(<DesktopQuestionnaireEditor />));
      expect(container.querySelectorAll('.card > .text-center img[src="/questionnaire-title.svg"]')).toHaveLength(1);
      expect(container.querySelector('h1')?.className).toBe('sr-only');
      expect(container.querySelector('a[href="#/details"]')?.textContent).toBe('前往魔法少女问卷');
      expect(container.querySelector('a[href="#/canshou"]')?.textContent).toBe('前往残兽问卷');
      expect(container.querySelector('a[href="#/"]')?.textContent).toBe('返回首页');
      expect(container.textContent).toContain('本地问卷库');
      expect(container.textContent).not.toContain('云端问卷库');
      const input = container.querySelector('textarea')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, JSON.stringify({ id: 'q', kind: 'magical-girl', title: '问卷', nativeAllowed: true, signature: 'forged', custom: { keep: true }, questions: [{ id: 'q1', question: '题目' }] }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => button('应用粘贴内容').click());
      act(() => { expect(mocks.blocker()).toBe(true); });
      const cancelledClose = vi.fn(); act(() => mocks.close({ preventDefault: cancelledClose })); expect(cancelledClose).toHaveBeenCalledOnce();
      const dirtyUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(dirtyUnload); expect(dirtyUnload.defaultPrevented).toBe(true);
      confirm.mockReturnValueOnce(true); act(() => { expect(mocks.blocker()).toBe(false); });
      confirm.mockClear();
      await act(async () => { button('另存到本地问卷库').click(); expect(mocks.blocker()).toBe(true); });
      expect(confirm).not.toHaveBeenCalled();
      await act(async () => { await vi.waitFor(() => expect(saved).toBeDefined()); });
      expect(saved?.provenance).toEqual({ kind: 'unsigned', execution: 'imported' });
      expect(saved?.storageLocation).toBe('local'); expect(saved?.cardType).toBe('questionnaire'); expect(saved?.data).toMatchObject({ nativeAllowed: false, custom: { keep: true } }); expect(saved?.data).not.toHaveProperty('signature'); expect(saved?.data).not.toHaveProperty('_native');
      expect(container.textContent).toContain('已另存为本地未签名问卷');
      act(() => { expect(mocks.blocker()).toBe(false); });
      const savedUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(savedUnload); expect(savedUnload.defaultPrevented).toBe(false);
      await act(async () => button('下载编辑 JSON').click());
      expect(anchor).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await create.mock.calls[0][0].text())).toEqual(saved?.data);
      const titleLabel = [...container.querySelectorAll('label')].find((node) => node.textContent === '问卷标题')!;
      const label = titleLabel.nextElementSibling as HTMLInputElement;
      act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(label, '新名称'); label.dispatchEvent(new Event('input', { bubbles: true })); });
      act(() => { expect(mocks.blocker()).toBe(true); });
      await act(async () => button('下载编辑 JSON').click()); act(() => { expect(mocks.blocker()).toBe(true); });
      act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '尚未解析'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      act(() => { expect(mocks.blocker()).toBe(true); });
      expect(fetch).not.toHaveBeenCalled(); expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled(); vi.advanceTimersByTime(60_000); expect(revoke).toHaveBeenCalledWith('blob:questionnaire');
    } finally { act(() => root.unmount()); container.remove(); }
  });
  it('keeps dirty after a malformed save ACK and confirms an explicit same-digest retry without overwriting', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const stored = new Map<string, string>();
    const writes: LocalCardRecordV1[] = [];
    // 显式延迟 ACK，覆盖真实摘要计算/IPC 晚于点击 act 完成的情况。
    const saveAcks: Array<() => void> = [];
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (command: string, args: { id?: string; request?: { writeMode: string; document: string } }) => {
      if (command === 'get_local_card') return stored.get(args.id!) ?? null;
      if (command !== 'save_local_card') throw new Error(`Unexpected IPC ${command}`);
      expect(args.request?.writeMode).toBe('insert-if-absent');
      const record = JSON.parse(args.request!.document) as LocalCardRecordV1;
      await new Promise<void>((resolve) => saveAcks.push(resolve));
      if (stored.has(record.id)) return { id: record.id, alreadyPresent: true };
      writes.push(record); stored.set(record.id, args.request!.document);
      return { id: record.id, alreadyPresent: 'unconfirmed' };
    });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const button = (name: string) => [...container.querySelectorAll('button')].find((node) => node.textContent === name)!;
    try {
      await act(async () => root.render(<DesktopQuestionnaireEditor />));
      const input = container.querySelector('[aria-label="粘贴问卷 JSON"]') as HTMLTextAreaElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, JSON.stringify({ id: 'ack', kind: 'magical-girl', title: '保存确认测试', questions: [{ id: 'one', question: '第一题' }] }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => button('应用粘贴内容').click());
      const draft = container.querySelector('pre')!.textContent;
      await act(async () => button('另存到本地问卷库').click());
      await act(async () => {
        await vi.waitFor(() => expect(saveAcks).toHaveLength(1));
        saveAcks[0]();
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('本次写入状态未知');
      expect(container.querySelector('pre')!.textContent).toBe(draft);
      expect(container.textContent).not.toContain('已另存为本地未签名问卷');
      act(() => expect(mocks.blocker()).toBe(true));
      const failedUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(failedUnload); expect(failedUnload.defaultPrevented).toBe(true);
      const firstDocument = [...stored.values()][0];
      expect(writes).toHaveLength(1);
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'save_local_card')).toHaveLength(1);
      await act(async () => button('另存到本地问卷库').click());
      await act(async () => {
        await vi.waitFor(() => expect(saveAcks).toHaveLength(2));
        saveAcks[1]();
      });
      expect(container.textContent).toContain('相同内容已在本地库，未覆盖已有记录');
      expect(stored.size).toBe(1); expect([...stored.values()][0]).toBe(firstDocument); expect(writes).toHaveLength(1);
      const saves = mocks.invoke.mock.calls.filter(([command]) => command === 'save_local_card');
      expect(saves).toHaveLength(2);
      expect(JSON.parse(saves[1][1].request.document).id).toBe(writes[0].id);
      expect(JSON.parse(saves[1][1].request.document).contentDigest).toBe(writes[0].contentDigest);
      expect(container.textContent).not.toContain('本次写入状态未知');
      act(() => expect(mocks.blocker()).toBe(false));
      expect(fetch).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); container.remove(); }
  });
});
