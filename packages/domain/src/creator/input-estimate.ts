import { compactQuestionnaireAnswerItems, formatQuestionnaireAnswers } from '../questionnaire';
import { buildCreatorPromptText } from './prompt';
import { buildCreatorPromptInput } from './server';
import type { CreatorRequestInput } from './types';

/** 仅投影已提交的输入内容，不包含系统指令、模板包装或输出预算。 */
export function buildCreatorInputEstimateText(input: CreatorRequestInput, loreText: string): string | null {
  try {
    const request = { ...input, questionnaireAnswers: compactQuestionnaireAnswerItems(input.questionnaireAnswers ?? []) };
    return [
      buildCreatorPromptText(buildCreatorPromptInput(request)),
      formatQuestionnaireAnswers(input.questionnaireAnswers ?? []),
      loreText,
    ].filter(Boolean).join('\n\n');
  } catch {
    // 未知规则或暂未完整的编辑态不能阻断页面，也不能假装成零 Token。
    return null;
  }
}
