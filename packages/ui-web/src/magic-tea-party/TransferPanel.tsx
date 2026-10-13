'use client';

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';

export type MagicTeaPartyTransferPanelProps = {
  activeTitle: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onImportFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onExportSession: () => void;
  onExportSessionJsonl: () => void;
  onExportArchive?: () => void;
  onExportArchiveZip?: () => void;
  renderError?: (message: string) => ReactNode;
};

export function MagicTeaPartyTransferPanel({ activeTitle, busy, error, notice, onImportFile, onExportSession, onExportSessionJsonl, onExportArchive, onExportArchiveZip, renderError }: MagicTeaPartyTransferPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="rounded-xl border border-pink-100 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-gray-800">导入 / 导出</div>
        <button
          type="button"
          className="text-xs text-pink-700 hover:underline"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </div>

      {collapsed ? (
        <div className="space-y-2 text-xs text-gray-500">
          <div>支持魔法茶会 JSON 与 SillyTavern JSONL。{onExportArchiveZip ? 'ZIP 导出会包含本地图片资源。' : null}</div>
          <div>{activeTitle !== null ? `当前会话：${activeTitle}` : '尚未选择会话。'}</div>
          {busy ? <div className="text-xs text-gray-500">处理中…</div> : null}
          {error ? <div className="text-xs text-red-600">{error}</div> : null}
          {notice ? <div className="text-xs text-emerald-600">{notice}</div> : null}
        </div>
      ) : (
        <>
          <div className="text-xs text-gray-500">支持魔法茶会 JSON 与 SillyTavern JSONL。{onExportArchiveZip ? 'ZIP 导出会包含本地图片资源。' : null}</div>
          {error && (
            <div>
              {renderError ? renderError(error) : <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
            </div>
          )}
          {notice && <div className="text-xs text-emerald-600">{notice}</div>}
          <div className="grid gap-2">
            <button
              type="button"
              className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-left text-sm font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              导入会话（JSON / JSONL）
            </button>
            <button
              type="button"
              className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-left text-sm font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { if (!busy) onExportSession?.(); }}
              disabled={busy}
            >
              导出当前会话（JSON）
            </button>
            <button
              type="button"
              className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-left text-sm font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { if (!busy) onExportSessionJsonl?.(); }}
              disabled={busy}
            >
              导出当前会话（SillyTavern JSONL）
            </button>
            {onExportArchive ? (
            <button
              type="button"
              className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-left text-sm font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { if (!busy) onExportArchive?.(); }}
              disabled={busy}
            >
              导出全部会话（JSON）
            </button>
            ) : null}
            {onExportArchiveZip ? (
            <button
              type="button"
              className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-left text-sm font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { if (!busy) onExportArchiveZip?.(); }}
              disabled={busy}
            >
              导出全部会话（ZIP，含图片）
            </button>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            className="hidden"
            type="file"
            accept=".json,.jsonl,application/json"
            onChange={(event) => { if (!busy) onImportFile(event); }}
            disabled={busy}
          />
        </>
      )}
    </div>
  );
}
