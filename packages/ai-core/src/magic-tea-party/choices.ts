import type { MagicTeaPartyNotice, MagicTeaPartyOutputSegment } from '@mahoshojo/domain/magic-tea-party/types';
import { buildMagicTeaPartyJsonlPreview, parseMagicTeaPartyJsonl } from './jsonl';

export type MagicTeaPartyChoicesCompletion = 'completed' | 'stopped' | 'failed' | 'blocked';

export type MagicTeaPartyChoicesProjection = {
  content: string;
  segments: MagicTeaPartyOutputSegment[];
  choices: { id: string; text: string }[];
  notices: MagicTeaPartyNotice[];
  lastChoices: { id: string; text: string }[] | null;
  status: 'done' | 'error' | 'blocked';
  error?: { code: string; message: string };
};

/** Retain displayable output, but only completed, valid choices can become actions. */
export const projectMagicTeaPartyChoices = (params: {
  rawText: string;
  completion: MagicTeaPartyChoicesCompletion;
}): MagicTeaPartyChoicesProjection => {
  const parsed = parseMagicTeaPartyJsonl(params.rawText);
  const preview = buildMagicTeaPartyJsonlPreview(params.rawText);
  const errorNotice = parsed.notices.find((notice) => notice.level === 'error');
  const choices = parsed.choices ?? [];
  const valid = params.completion === 'completed' && choices.length > 0 && !errorNotice;
  const projection: MagicTeaPartyChoicesProjection = {
    content: preview.trim() ? preview : params.rawText,
    segments: parsed.segments,
    choices: valid ? choices : [],
    notices: parsed.notices,
    lastChoices: valid ? choices : null,
    status: params.completion === 'blocked' ? 'blocked' : valid ? 'done' : 'error',
  };
  if (valid) return projection;

  if (params.completion === 'blocked') {
    projection.error = { code: 'choices_blocked', message: '选项生成已被阻止。' };
  } else if (params.completion === 'stopped') {
    projection.error = { code: 'choices_stopped', message: '选项生成已停止，已保留收到的内容。' };
  } else if (params.completion === 'failed') {
    projection.error = { code: 'choices_failed', message: '选项生成失败，已保留收到的内容。' };
  } else if (errorNotice) {
    projection.error = { code: errorNotice.code || 'choices_notice_error', message: errorNotice.message };
  } else {
    projection.error = params.rawText.trim()
      ? { code: 'choices_invalid', message: '模型未返回有效行动选项，已保留原始输出。' }
      : { code: 'choices_empty', message: '模型返回了空选项。' };
  }
  return projection;
};
