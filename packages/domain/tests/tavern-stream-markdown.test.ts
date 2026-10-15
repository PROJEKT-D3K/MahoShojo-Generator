import { describe, expect, it } from 'vitest';
import { GENERAL_CHARACTER_TEMPLATE_ID, GENERAL_SCENARIO_TEMPLATE_ID, type DataCardTemplate } from '@mahoshojo/domain/data-cards';
import { buildGeneralCharacterCardFromMarkdown, buildGeneralScenarioCardFromMarkdown } from '@mahoshojo/domain/markdown-card';
import { projectTavernStreamMarkdown } from '@mahoshojo/domain/tavern-card';

const templates: DataCardTemplate[] = ['general', 'magical-girl', 'canshou', 'scenario', 'general-scenario'];
const markdownCases = [
  '', ' \r\n ', '# 首标题\r\n名字：真名\r\n代号：花名\r\n标题：场景名\r\n完整正文🪄',
  '```json\n{"templateId":"magical-girl","signature":"forged","_tavern":{"raw":"model"}}\n```',
  '# **装饰标题**\n- codename: `Rose`\nname: Alice\nscenario title: Garden',
  `${'\n'.repeat(120)}名字：扫描之外\n正文`,
];

describe('Tavern Markdown projection', () => {
  it.each(templates)('matches the old Web preview/final projection for %s', (template) => {
    for (const markdown of markdownCases) {
      for (const sourceName of ['', '   ', ' **原名** '.repeat(20)]) {
        const expected = template === 'scenario' || template === 'general-scenario'
          ? buildGeneralScenarioCardFromMarkdown({ markdown, fallbackTitle: sourceName, defaultTitle: '情景' })
          : buildGeneralCharacterCardFromMarkdown({ markdown, fallbackName: sourceName, defaultName: template === 'magical-girl' ? '魔法少女' : template === 'canshou' ? '残兽' : '角色' });
        const actual = projectTavernStreamMarkdown({ template, markdown, sourceName });
        expect(actual).toEqual(expected);
        expect(actual.card.content).toBe(markdown);
        expect(actual.card).not.toHaveProperty('signature');
        expect(actual.card).not.toHaveProperty('isPreset');
        expect(actual.card).not.toHaveProperty('_tavern');
        expect(actual.card).not.toHaveProperty('userAnswers');
        expect(actual.card).not.toHaveProperty('elements');
      }
    }
  });

  it.each([
    ['general', GENERAL_CHARACTER_TEMPLATE_ID, '角色'],
    ['magical-girl', GENERAL_CHARACTER_TEMPLATE_ID, '魔法少女'],
    ['canshou', GENERAL_CHARACTER_TEMPLATE_ID, '残兽'],
    ['scenario', GENERAL_SCENARIO_TEMPLATE_ID, '情景'],
    ['general-scenario', GENERAL_SCENARIO_TEMPLATE_ID, '情景'],
  ] as const)('uses the actual output template and default name for %s', (template, templateId, title) => {
    const { card } = projectTavernStreamMarkdown({ template, markdown: '' });
    expect(card).toEqual(templateId === GENERAL_SCENARIO_TEMPLATE_ID
      ? { templateId, title, content: '' }
      : { templateId, name: title, content: '' });
    const fromSource = projectTavernStreamMarkdown({ template, markdown: '', sourceName: ' __原名__ ' }).card;
    expect(fromSource).toEqual(templateId === GENERAL_SCENARIO_TEMPLATE_ID
      ? { templateId, title: '原名', content: '' }
      : { templateId, name: '原名', content: '' });
  });

  it('keeps field/headline/fallback precedence and codename without asserting completion', () => {
    expect(projectTavernStreamMarkdown({ template: 'magical-girl', markdown: '# 标题\n名字：真名\n代号：花名', sourceName: '原名' }).card)
      .toEqual({ templateId: GENERAL_CHARACTER_TEMPLATE_ID, name: '真名', codename: '花名', content: '# 标题\n名字：真名\n代号：花名' });
    expect(projectTavernStreamMarkdown({ template: 'scenario', markdown: '# 标题\n情景名：字段标题', sourceName: '原名' }).card)
      .toEqual({ templateId: GENERAL_SCENARIO_TEMPLATE_ID, title: '字段标题', content: '# 标题\n情景名：字段标题' });
    expect(projectTavernStreamMarkdown({ template: 'general', markdown: '# 未完', sourceName: '原名' }).card)
      .toEqual({ templateId: GENERAL_CHARACTER_TEMPLATE_ID, name: '未完', content: '# 未完' });
  });
});
