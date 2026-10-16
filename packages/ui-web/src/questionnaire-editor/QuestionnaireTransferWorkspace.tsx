'use client';

import { useId, type ChangeEventHandler, type ReactNode } from 'react';

export type QuestionnaireTransferWorkspaceProps = {
  importText: string;
  onImportTextChange: (text: string) => void;
  onImportFileChange: ChangeEventHandler<HTMLInputElement>;
  onApplyPaste: () => void;
  importDescription?: ReactNode;
  fileInputLabel?: string;
  fileInputAccept?: string;
  applyPasteDisabled?: boolean;
  onPasteFromClipboard?: () => void;
  onClearPaste?: () => void;
  jsonPreview: string;
  previewExpanded: boolean;
  onPreviewExpandedChange: (expanded: boolean) => void;
  onCopyJson?: () => void;
  onDownloadJson: () => void;
  onDownloadSource?: () => void;
  downloadLabel?: string;
  editedExportDisabled?: boolean;
  disabled?: boolean;
};

/** Shared transfer view; parsing, source retention and side effects stay with each host. */
export function QuestionnaireTransferWorkspace({
  importText, onImportTextChange, onImportFileChange, onApplyPaste,
  importDescription = '支持粘贴或上传 JSON，导入后会覆盖当前编辑内容。',
  fileInputLabel = '上传问卷 JSON 文件', fileInputAccept = 'application/json',
  applyPasteDisabled = false, onPasteFromClipboard, onClearPaste,
  jsonPreview, previewExpanded, onPreviewExpandedChange, onCopyJson,
  onDownloadJson, onDownloadSource, downloadLabel = '下载 JSON',
  editedExportDisabled = false, disabled = false,
}: QuestionnaireTransferWorkspaceProps) {
  const id = useId();
  const importHeadingId = `${id}-import`;
  const exportHeadingId = `${id}-export`;
  const fileId = `${id}-file`;
  const pasteId = `${id}-paste`;
  const previewId = `${id}-preview`;

  return <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_0.9fr]">
    <section aria-labelledby={importHeadingId} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <fieldset disabled={disabled} className="min-w-0 border-0 p-0 disabled:opacity-70">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id={importHeadingId} className="text-sm font-semibold text-slate-700">导入现有问卷</h3>
            <p className="mt-1 text-xs text-slate-500">{importDescription}</p>
          </div>
          {onPasteFromClipboard ? <button type="button" onClick={onPasteFromClipboard} className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100">从剪贴板导入</button> : null}
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label htmlFor={fileId} className="text-xs text-slate-500">{fileInputLabel}</label>
            <input id={fileId} type="file" accept={fileInputAccept} onChange={onImportFileChange} className="input-field mt-1 file:mr-4 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-xs file:text-slate-600" />
            <p className="mt-1 text-xs text-slate-400">上传后会自动导入并应用。</p>
          </div>
          <div>
            <label htmlFor={pasteId} className="text-xs text-slate-500">粘贴问卷 JSON</label>
            <textarea id={pasteId} aria-label="粘贴问卷 JSON" value={importText} onChange={(event) => onImportTextChange(event.target.value)} placeholder="在此粘贴问卷 JSON" className="input-field mt-1 h-28" />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <button type="button" onClick={onApplyPaste} disabled={applyPasteDisabled} className="rounded-lg border border-indigo-200 px-3 py-1 text-indigo-600 hover:text-indigo-700 disabled:opacity-50">应用粘贴内容</button>
              {onClearPaste ? <button type="button" onClick={onClearPaste} className="rounded-lg border border-slate-200 px-3 py-1 text-slate-500 hover:text-slate-700">清空</button> : null}
            </div>
          </div>
        </div>
      </fieldset>
    </section>
    <section aria-labelledby={exportHeadingId} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={exportHeadingId} className="text-sm font-semibold text-slate-700">导出问卷</h3>
          <p className="mt-1 text-xs text-slate-500">编辑导出会规范化字段；可另外下载未改动的导入来源。</p>
        </div>
        <fieldset disabled={disabled} className="flex min-w-0 flex-wrap gap-2 border-0 p-0 text-xs disabled:opacity-70">
          {onCopyJson ? <button type="button" onClick={onCopyJson} disabled={editedExportDisabled} className="rounded-full border border-indigo-200 px-3 py-1 text-indigo-600 hover:text-indigo-700">复制 JSON</button> : null}
          {onDownloadSource ? <button type="button" onClick={onDownloadSource} className="rounded-full border border-indigo-200 px-3 py-1 text-indigo-600 hover:text-indigo-700">下载原始来源</button> : null}
          <button type="button" onClick={onDownloadJson} disabled={editedExportDisabled} className="rounded-full border border-indigo-200 px-3 py-1 text-indigo-600 hover:text-indigo-700">{downloadLabel}</button>
        </fieldset>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span>预览（{jsonPreview.length} 字符）</span>
        <button type="button" aria-expanded={previewExpanded} aria-controls={previewId} onClick={() => onPreviewExpandedChange(!previewExpanded)} className="text-indigo-600 hover:underline">{previewExpanded ? '收起预览' : '展开预览'}</button>
      </div>
      <div id={previewId} hidden={!previewExpanded} className="mt-2 max-h-64 overflow-auto rounded-lg bg-white p-3 text-xs text-slate-600 whitespace-pre-wrap">
        <pre className="whitespace-pre-wrap" style={{ fontFamily: 'inherit' }}>{jsonPreview}</pre>
      </div>
    </section>
  </div>;
}

export function QuestionnaireEditorGuide() {
  return <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
    <p className="font-semibold text-slate-800 mb-2">创建指引</p>
    <ul className="list-disc pl-5 space-y-1">
      <li>问卷由「题目列表」组成，每道题可设置提示、选项与字数限制。</li>
      <li><code className="bg-slate-200 px-1 rounded">placeholder</code> 用于输入框提示，<code className="bg-slate-200 px-1 rounded">helperText</code> 用于补充说明。</li>
      <li><code className="bg-slate-200 px-1 rounded">suggestions</code> 会显示为灵感按钮（可逐条新增/删除）；<code className="bg-slate-200 px-1 rounded">options</code> 是推荐选项列表，支持设置「标签 / 内容 / 禁用」。</li>
      <li><code className="bg-slate-200 px-1 rounded">displayIf</code> 支持条件显示；<code className="bg-slate-200 px-1 rounded">jump</code> 可设置跳题规则。</li>
      <li><code className="bg-slate-200 px-1 rounded">optionsFrom</code> / <code className="bg-slate-200 px-1 rounded">suggestionsFrom</code> 可引用其他题目的选项或灵感。</li>
      <li>最大字数为建议上限，超出仍可提交但会影响原生性；留空表示不设题目上限（仍受统一原生上限影响）。</li>
      <li><code className="bg-slate-200 px-1 rounded">loreMarkdown</code> 是可选“设定文本”，会作为参考资料提供给 AI（不是题目，不需要作答）。</li>
      <li>Logo 仅支持站内路径或可信 HTTPS 外链，推荐使用下方快捷 Logo。</li>
      <li>更多高级字段可写入「额外字段 JSON」，会并入该题的最终结构。</li>
    </ul>
  </div>;
}
