// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScenarioResultActions } from '../src/scenario';
import { CloudCardActionButtons, CloudCardActionFeedback } from '../src/cloud-save/CloudCardActionButtons';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('keeps host feedback and full JSON controls outside action rows', () => {
  act(() => root.render(<ScenarioResultActions
    saveActions={<div><CloudCardActionButtons onSave={vi.fn()} onReplace={vi.fn()} /><CloudCardActionFeedback><p role="alert">云端失败，本地结果保留</p></CloudCardActionFeedback></div>}
    saveFeedback={<p role="status">本地已保存</p>}
    exportActions={<button>下载 JSON 文件</button>}
    exportControl={<textarea readOnly value={'{"complete":true}'} />}
    sizeIndicator={<p>本地容量提示</p>}
  />));
  const [saving, exporting] = container.querySelectorAll('section');
  expect(saving.getAttribute('aria-label')).toBe('保存数据卡');
  expect(exporting.getAttribute('aria-label')).toBe('保存原始数据');
  expect(saving.querySelector('[data-testid="cloud-card-action-buttons"]')?.children).toHaveLength(2);
  expect(saving.querySelector('[data-testid="cloud-card-action-buttons"] [role]')).toBeNull();
  expect(saving.textContent).toContain('本地已保存');
  const text = exporting.querySelector('textarea')!;
  expect(text.parentElement).toBe(exporting);
  expect(text.value).toBe('{"complete":true}');
  expect(text.readOnly).toBe(true);
  expect(exporting.textContent).toContain('本地容量提示');
});

it('uses native non-submit primary/secondary buttons and only host callbacks', () => {
  const save = vi.fn(); const replace = vi.fn(); const submit = vi.fn((event) => event.preventDefault());
  const render = (saveDisabled: boolean, replaceDisabled: boolean) => act(() => root.render(<form onSubmit={submit}>
    <CloudCardActionButtons onSave={save} onReplace={replace} saveDisabled={saveDisabled} replaceDisabled={replaceDisabled} saveLabel="已保存到云端" />
  </form>));
  render(true, false);
  const [saveButton, replaceButton] = container.querySelectorAll('button');
  expect(saveButton.type).toBe('button'); expect(replaceButton.type).toBe('button');
  expect(saveButton.className).toContain('ui-web-generation-action--primary');
  expect(replaceButton.className).toContain('ui-web-generation-action--secondary');
  expect(saveButton.textContent).toBe('已保存到云端');
  act(() => { saveButton.click(); replaceButton.click(); });
  expect(save).not.toHaveBeenCalled(); expect(replace).toHaveBeenCalledOnce();
  render(false, true);
  act(() => { saveButton.click(); replaceButton.click(); });
  expect(save).toHaveBeenCalledOnce(); expect(replace).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});
