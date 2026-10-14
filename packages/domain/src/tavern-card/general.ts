import { GENERAL_SCENARIO_TEMPLATE_ID } from '../data-cards';
import type { TavernCardNormalized } from './types';

export const buildGeneralMarkdown = (normalized: TavernCardNormalized): string => {
  const lines: string[] = [];
  lines.push(`# 角色：${normalized.name}`);
  if (normalized.description?.trim()) {
    lines.push('');
    lines.push('## 描述');
    lines.push(normalized.description.trim());
  }
  if (normalized.personality?.trim()) {
    lines.push('');
    lines.push('## 性格');
    lines.push(normalized.personality.trim());
  }
  if (normalized.scenario?.trim()) {
    lines.push('');
    lines.push('## 场景');
    lines.push(normalized.scenario.trim());
  }
  if (normalized.firstMes?.trim()) {
    lines.push('');
    lines.push('## 开场白');
    lines.push(normalized.firstMes.trim());
  }
  if (normalized.mesExample?.trim()) {
    lines.push('');
    lines.push('## 对话样例');
    lines.push(normalized.mesExample.trim());
  }
  if (normalized.tags && normalized.tags.length > 0) {
    lines.push('');
    lines.push('## 标签');
    lines.push(normalized.tags.join('、'));
  }
  return lines.join('\n');
};


export const buildGeneralScenarioMarkdown = (normalized: TavernCardNormalized): string => {
  const title = normalized.name?.trim() || '未命名情景';
  const lines: string[] = [];
  lines.push(`# ${title}`);

  if (normalized.scenario?.trim()) {
    lines.push('');
    lines.push('## 场景概览');
    lines.push(normalized.scenario.trim());
  }

  if (normalized.description?.trim()) {
    lines.push('');
    lines.push('## 背景摘要');
    lines.push(normalized.description.trim());
  }

  if (normalized.personality?.trim()) {
    lines.push('');
    lines.push('## 氛围');
    lines.push(normalized.personality.trim());
  }

  if (normalized.firstMes?.trim()) {
    lines.push('');
    lines.push('## 开场白');
    lines.push(normalized.firstMes.trim());
  }

  if (normalized.mesExample?.trim()) {
    lines.push('');
    lines.push('## 对话样例');
    lines.push(normalized.mesExample.trim());
  }

  if (normalized.tags && normalized.tags.length > 0) {
    lines.push('');
    lines.push('## 标签');
    lines.push(normalized.tags.join('、'));
  }

  return lines.join('\n');
};

/** Original Web rule mapping, without preservation or host-side save effects. */
export const buildTavernGeneralScenarioCard = (normalized: TavernCardNormalized) => ({
  templateId: GENERAL_SCENARIO_TEMPLATE_ID as typeof GENERAL_SCENARIO_TEMPLATE_ID,
  title: normalized.name || '未命名情景',
  content: buildGeneralScenarioMarkdown(normalized),
});
