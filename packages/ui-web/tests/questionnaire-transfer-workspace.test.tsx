// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionnaireTransferWorkspace, type QuestionnaireTransferWorkspaceProps } from '../src/questionnaire-editor/QuestionnaireTransferWorkspace';

let container: HTMLDivElement;
let root: Root;
let props: QuestionnaireTransferWorkspaceProps;
const button = (text: string) => {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const render = (patch: Partial<QuestionnaireTransferWorkspaceProps> = {}) => {
  props = { ...props, ...patch };
  act(() => root.render(<QuestionnaireTransferWorkspace {...props} />));
};
const click = (text: string) => act(() => button(text).click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = {
    importText: '', onImportTextChange: vi.fn(), onImportFileChange: vi.fn(), onApplyPaste: vi.fn(),
    jsonPreview: '{"title":"当前编辑"}', previewExpanded: true, onPreviewExpandedChange: vi.fn(), onDownloadJson: vi.fn(),
  };
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('controlled questionnaire transfer workspace', () => {
  it('forwards input intent without parsing or adding optional host capabilities', () => {
    render();
    expect(container.textContent).not.toContain('从剪贴板导入');
    expect(container.textContent).not.toContain('复制 JSON');
    expect(container.textContent).not.toContain('清空');
    expect(container.textContent).not.toContain('下载原始来源');
    const textarea = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '{not parsed');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(props.onImportTextChange).toHaveBeenCalledWith('{not parsed');
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(['{}'], '问卷.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(props.onImportFileChange).toHaveBeenCalledOnce();
    click('应用粘贴内容'); expect(props.onApplyPaste).toHaveBeenCalledOnce();
    expect(props.onDownloadJson).not.toHaveBeenCalled();
  });

  it('keeps source download separate from invalid edited output and supports host-only actions', () => {
    const source = vi.fn(); const copy = vi.fn(); const clipboard = vi.fn(); const clear = vi.fn();
    render({ onDownloadSource: source, onCopyJson: copy, onPasteFromClipboard: clipboard, onClearPaste: clear, editedExportDisabled: true });
    click('复制 JSON'); click('下载 JSON');
    expect(copy).not.toHaveBeenCalled(); expect(props.onDownloadJson).not.toHaveBeenCalled();
    click('下载原始来源'); expect(source).toHaveBeenCalledOnce();
    click('从剪贴板导入'); click('清空');
    expect(clipboard).toHaveBeenCalledOnce(); expect(clear).toHaveBeenCalledOnce();
    render({ editedExportDisabled: false }); click('复制 JSON'); click('下载 JSON');
    expect(copy).toHaveBeenCalledOnce(); expect(props.onDownloadJson).toHaveBeenCalledOnce();
  });

  it('blocks transfer actions while busy without blocking the read-only preview', () => {
    const source = vi.fn(); const copy = vi.fn(); const clipboard = vi.fn(); const clear = vi.fn();
    render({ disabled: true, onDownloadSource: source, onCopyJson: copy, onPasteFromClipboard: clipboard, onClearPaste: clear });
    for (const text of ['应用粘贴内容', '从剪贴板导入', '清空', '复制 JSON', '下载 JSON', '下载原始来源']) click(text);
    for (const callback of [source, copy, clipboard, clear, props.onApplyPaste, props.onDownloadJson]) expect(callback).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')!.matches(':disabled')).toBe(true);
    expect(container.querySelector('input')!.matches(':disabled')).toBe(true);
    const toggle = button('收起预览'); const previewId = toggle.getAttribute('aria-controls')!;
    expect(toggle.matches(':disabled')).toBe(false);
    click('收起预览'); expect(props.onPreviewExpandedChange).toHaveBeenCalledWith(false);
    render({ previewExpanded: false });
    expect(document.getElementById(previewId)?.hidden).toBe(true);
    expect(button('展开预览').getAttribute('aria-controls')).toBe(previewId);
    click('展开预览'); expect(props.onPreviewExpandedChange).toHaveBeenLastCalledWith(true);
  });

  it('associates each instance labels and preview controls without colliding ids', () => {
    act(() => root.render(<><QuestionnaireTransferWorkspace {...props} /><QuestionnaireTransferWorkspace {...props} /></>));
    const labels = [...container.querySelectorAll('label')];
    expect(labels).toHaveLength(4);
    for (const label of labels) expect(label.control).not.toBeNull();
    expect(new Set(labels.map((label) => label.htmlFor)).size).toBe(4);
    const toggles = [...container.querySelectorAll('button[aria-controls]')];
    expect(toggles).toHaveLength(2);
    expect(new Set(toggles.map((toggle) => toggle.getAttribute('aria-controls'))).size).toBe(2);
    for (const toggle of toggles) expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.textContent).toBe(props.jsonPreview);
  });
});
