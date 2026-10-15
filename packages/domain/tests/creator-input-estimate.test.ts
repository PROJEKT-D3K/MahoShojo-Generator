import { describe, expect, it } from 'vitest';
import { buildCreatorInputEstimateText } from '../src/creator/input-estimate';
import { buildCreatorPromptInput } from '../src/creator/server';
import { buildCreatorPromptText } from '../src/creator/prompt';
import { createDefaultBuildRuleInputs } from '../src/creator/build-rules';
import { evaluateBuildRuleState } from '../src/creator/build-rule-runtime';
import { compactQuestionnaireAnswerItems, formatQuestionnaireAnswers } from '../src/questionnaire';
import type { CreatorRequestInput } from '../src/creator/types';

const input: CreatorRequestInput = {
  template: 'magical-girl',
  freeformBrief: '自由说明',
  questionnaires: [{ questionnaireId: 'q', title: '问卷标题' }],
  questionnaireAnswers: [{ question: '性格', answer: '温柔', questionnaireId: 'q', questionnaireTitle: '问卷标题' }],
  buildRules: [evaluateBuildRuleState({ ruleId: 'arena-trpg-lite', inputs: createDefaultBuildRuleInputs('arena-trpg-lite') })],
  primaryRuleId: 'arena-trpg-lite',
};

describe('creator input estimate projection', () => {
  it('uses the existing prompt projections for all submitted inputs without mutation', () => {
    const before = JSON.stringify(input);
    const result = buildCreatorInputEstimateText(input, '已启用设定');
    expect(result).toBe([
      buildCreatorPromptText(buildCreatorPromptInput({ ...input, questionnaireAnswers: compactQuestionnaireAnswerItems(input.questionnaireAnswers!) })),
      formatQuestionnaireAnswers(input.questionnaireAnswers!),
      '已启用设定',
    ].join('\n\n'));
    expect(result).toContain('自由说明');
    expect(result).toContain('温柔');
    expect(result).toContain('问卷标题');
    expect(result!.length).toBeGreaterThan(buildCreatorInputEstimateText({ ...input, buildRules: [], primaryRuleId: null }, '')!.length);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('reacts to brief, answers and enabled lore independently without requiring a generation', () => {
    const base = { ...input, buildRules: [], primaryRuleId: null };
    expect(buildCreatorInputEstimateText({ ...base, freeformBrief: '修改说明' }, '')).toContain('修改说明');
    expect(buildCreatorInputEstimateText({ ...base, questionnaireAnswers: [{ question: '性格', answer: '谨慎' }] }, '')).toContain('谨慎');
    expect(buildCreatorInputEstimateText(base, '新增设定')).toContain('新增设定');
    expect(buildCreatorInputEstimateText(base, '')).not.toContain('新增设定');
  });

  it('returns unavailable for unknown rules rather than throwing or reporting a fake zero', () => {
    const unknown = { ...input, buildRules: [{ ...input.buildRules[0]!, ruleId: 'unknown' }], primaryRuleId: 'unknown' };
    expect(buildCreatorInputEstimateText(unknown, '')).toBeNull();
    expect(buildCreatorInputEstimateText({ ...input, buildRules: [], primaryRuleId: null, questionnaires: [], questionnaireAnswers: [], freeformBrief: '' }, '')).not.toBeNull();
  });
});
