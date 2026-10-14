import { useRef, useState } from 'react';
import { GENERAL_CHARACTER_TEMPLATE_ID, GENERAL_SCENARIO_TEMPLATE_ID } from '@mahoshojo/domain/data-cards';
import { MAX_TAVERN_TEXT_BYTES, TAVERN_CANSHOU_TEMPLATE_ID } from '@mahoshojo/domain/tavern-card';
import { buildSafeFileName } from '../client';
import type { TavernExportFilePort } from './controls';

/** Web may intentionally omit raw via its existing keepRaw option. */
interface TavernProjectionBase {
  _tavern?: { raw?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}
export type TavernProjection = TavernProjectionBase & (
  | { templateId: typeof GENERAL_CHARACTER_TEMPLATE_ID; name: string; content: string }
  | { templateId: typeof GENERAL_SCENARIO_TEMPLATE_ID; title: string; content: string }
  | { templateId: typeof TAVERN_CANSHOU_TEMPLATE_ID; name: string; appearance: string; coreEmotion: string; researcherNotes: string }
);
export const getTavernProjectionTitle = (data: TavernProjection): string =>
  data.templateId === GENERAL_SCENARIO_TEMPLATE_ID ? (data.title ?? '未命名情景') : (data.name ?? '未命名角色');
export const getTavernProjectionCardType = (data: TavernProjection): 'character' | 'scenario' =>
  data.templateId === GENERAL_SCENARIO_TEMPLATE_ID ? 'scenario' : 'character';

export function TavernLocalProjection({ data, disabled, exportFile, saveCard, hideExport = false, conversionMode = 'rules' }: {
  conversionMode?: 'rules' | 'ai'; data: TavernProjection; disabled?: boolean; hideExport?: boolean; exportFile: TavernExportFilePort;
  saveCard: (data: TavernProjection) => Promise<'saved' | 'already-present'>;
}) {
  const isCanshou = data.templateId === TAVERN_CANSHOU_TEMPLATE_ID;
  const cardLabel = isCanshou ? '残兽卡' : '通用卡';
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ data: TavernProjection; text: string } | null>(null);
  async function run(save: boolean) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setNotice(null);
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      if (bytes.length > MAX_TAVERN_TEXT_BYTES) throw new Error(`${cardLabel}连同原件超过 4 MiB 本地往返上限，请先导出酒馆原件。`);
      if (save) {
        const outcome = await saveCard(data);
        setNotice({ data, text: outcome === 'saved' ? (conversionMode === 'ai' ? '已保存到本地卡库（未签名 AI 转换）。' : '已保存到本地卡库（未签名导入）。') : '本地已有相同内容，未覆盖已有记录。' });
      } else {
        await exportFile({ name: buildSafeFileName(getTavernProjectionTitle(data), 'json', getTavernProjectionCardType(data)), bytes, mimeType: 'application/json' });
        setNotice({ data, text: '已发起下载，请在系统下载界面确认保存。' });
      }
    } catch (error) { setNotice({ data, text: error instanceof Error ? error.message : '保存失败，原件仍保留，可重试。' }); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="rounded-xl border border-pink-200 bg-white/70 p-4">
    <div className="text-sm font-semibold text-pink-700">{conversionMode === 'ai' ? (getTavernProjectionCardType(data) === 'scenario' ? '通用情景（AI 深度转换）' : '通用角色（AI 深度转换）') : isCanshou ? '残兽（保守规则映射）' : getTavernProjectionCardType(data) === 'scenario' ? '通用情景（规则映射）' : '通用角色（规则映射）'}</div>
    <p className="mt-2 text-xs text-gray-600">{conversionMode === 'ai' ? '正文由所选模型根据裁剪后的设定整理，并通过 schema 校验。' : isCanshou ? '保守映射：名称保留；描述转为外观，性格转为核心情感，场景与对话样例转为研究员笔记。开场白与标签不进入残兽正文。' : '正文仅映射描述、性格、场景、开场白、对话样例与标签。'}世界书、脚本、系统提示和其他扩展不会在转换卡中执行；{data._tavern?.raw !== undefined ? '完整原件保留在 _tavern.raw。' : '未保留完整原件；未映射字段不会出现在转换结果中。'}转换结果未签名，原件签名不适用于新正文。修改转换卡不会自动同步到酒馆原件。</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {!hideExport ? <button type="button" disabled={disabled || busy} onClick={() => void run(false)} className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-sm text-pink-700 disabled:opacity-50">下载{cardLabel} JSON</button> : null}
      <button type="button" disabled={disabled || busy} onClick={() => void run(true)} className="rounded-xl bg-pink-600 px-4 py-2 text-sm text-white disabled:opacity-50">保存{cardLabel}到本地库</button>
    </div>
    {notice?.data === data ? <p role="status" className="mt-2 text-xs text-gray-700">{notice.text}</p> : null}
  </div>;
}
