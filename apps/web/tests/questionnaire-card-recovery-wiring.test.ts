import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const questionnaireEditorSource = readFileSync(
  join(process.cwd(), 'components/creation/QuestionnaireEditorPage.tsx'),
  'utf8',
);
const characterManagerSource = readFileSync(
  join(process.cwd(), 'components/character/CharacterManagerPage.tsx'),
  'utf8',
);
const compatModalSource = readFileSync(
  join(process.cwd(), 'components/CharManager/QuestionnaireCompatModal.tsx'),
  'utf8',
);

describe('legacy questionnaire data-card recovery wiring', () => {
  test('问卷编辑器通过摘要纳入旧问卷，载入不隐式修复类型', () => {
    expect(questionnaireEditorSource).toContain("useDataCardSummaryPage('my'");
    expect(questionnaireEditorSource).toContain("types: ['questionnaire'], includeLegacyQuestionnaires: true");
    expect(questionnaireEditorSource).toContain('handleLoadQuestionnaireCard');
    expect(questionnaireEditorSource).not.toContain('repairQuestionnaireType');
    expect(questionnaireEditorSource).not.toContain('onReplaceCard=');
    expect(questionnaireEditorSource).not.toContain('replaceCard(');
  });

  test('角色管理中心按内容识别错标问卷并绑定真实卡片', () => {
    expect(characterManagerSource).toContain('isQuestionnaireDataCard');
    expect(characterManagerSource).toContain('openQuestionnaireCompat(raw, {');
  });

  test('兼容编辑器不再提供旧修复覆写链，父页同步移除成功回调', () => {
    expect(compatModalSource).not.toContain('repairQuestionnaireType');
    expect(compatModalSource).not.toContain('replaceCard');
    expect(characterManagerSource).not.toContain('onReplaceSuccess=');
    expect(characterManagerSource).not.toContain('此处仅提供兼容替换能力');
  });
});
