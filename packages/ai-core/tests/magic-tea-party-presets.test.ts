import { describe, expect, it } from 'vitest';
import type { MagicTeaPartyScenario, MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';
import { MAGIC_TEA_PARTY_PRESETS, buildMagicTeaPartyMainPrompt, projectMagicTeaPartyPreset } from '../src/magic-tea-party';

const scenario: MagicTeaPartyScenario = { id: 'local-scene', title: '雨夜茶馆', source: 'local', card: { content: '保留原始情景' } };
const session = (): MagicTeaPartySession => ({
  id: 'tea', title: '原会话', createdAt: 1, updatedAt: 2, pinnedAt: 3, pinnedOrder: 4,
  roles: [{ id: 'role', name: '旅人', source: 'local', card: { content: '角色原文' } }],
  scenario, auxScenarios: [{ ...scenario, id: 'aux' }], draft: '尚未发送', summary: '原摘要',
  settings: { providerId: 'openai', modelId: 'test', temperature: 0.3, outputFormat: 'markdown',
    enableChoices: false, choiceCount: 9, userDisplayName: '读者', autoSummaryEnabled: true },
});

describe('shared Tea preset projection', () => {
  it.each(MAGIC_TEA_PARTY_PRESETS)('applies $id as one narrow style/worldbook/scenario patch without mutating its source', preset => {
    const source = session(); const before = structuredClone(source);
    const result = projectMagicTeaPartyPreset(source, preset.id)!;
    expect(result.action).toBe('apply'); expect(result.preset).toBe(preset);
    expect(Object.keys(result.patch).sort()).toEqual(['auxScenarios', 'scenario', 'settings']);
    expect(result.patch.settings).toEqual({ ...source.settings, presetId: preset.id, worldbookPresetId: preset.worldbookPresetId, ...preset.defaultSettings, outputPlan: { choices: 'auto', summary: 'off', updates: 'off' } });
    expect(result.patch.scenario).toEqual({ id: 'preset-scenario', title: preset.defaultScenario.title,
      source: 'preset', presetId: preset.id, card: { title: preset.defaultScenario.title, content: preset.defaultScenario.content, templateId: '通用情景卡（Markdown）' } });
    expect(result.patch.auxScenarios).toEqual([]);
    expect(result.preferencePatch).toEqual({ lastPresetId: preset.id, lastWorldbookPresetId: preset.worldbookPresetId, ...preset.defaultSettings });
    const next = { ...source, ...result.patch };
    expect(buildMagicTeaPartyMainPrompt({ session: next, roles: next.roles, messages: [] })).toContain(`一共 ${preset.defaultSettings.choiceCount} 条`);
    for (const key of ['roles', 'draft', 'summary', 'title', 'createdAt', 'updatedAt', 'pinnedAt', 'pinnedOrder'] as const) expect(next[key]).toBe(source[key]);
    expect(source).toEqual(before);
  });

  it.each(['off', 'auto', 'on'] as const)('makes preset choices effective from %s without changing summary or update plans', choices => {
    const source = session(); source.settings.outputPlan = { choices, summary: 'on', updates: 'auto' };
    const projection = projectMagicTeaPartyPreset(source, 'arena-daily')!;
    const next = { ...source, ...projection.patch };
    expect(next.settings.outputPlan).toEqual({ choices: choices === 'on' ? 'on' : 'auto', summary: 'on', updates: 'auto' });
    const prompt = buildMagicTeaPartyMainPrompt({ session: next, roles: [], messages: [] });
    expect(prompt).toContain(`- choices：${choices === 'on' ? 'on' : 'auto'}`);
    expect(prompt).toContain('一共 4 条');
    expect(prompt).toContain(choices === 'on' ? '必须在本轮结尾输出 choices' : '在需要时输出 choices');
    expect(projectMagicTeaPartyPreset(next, 'arena-daily')!.patch.settings.outputPlan).toBe(next.settings.outputPlan);
    expect(source.settings.outputPlan.choices).toBe(choices);
  });

  it('removes the same preset but retains its current output settings and manually added scenarios', () => {
    const source = session();
    source.settings = { ...source.settings, presetId: 'arena-daily', worldbookPresetId: 'arena-core' };
    source.auxScenarios = [scenario, { ...scenario, id: 'preset-source', source: 'preset' },
      { ...scenario, id: 'preset-id', presetId: 'arena-daily' }, { ...scenario, id: 'other-id', presetId: 'arena-classic' }];
    const before = structuredClone(source);
    const result = projectMagicTeaPartyPreset(source, 'arena-daily')!;
    expect(result.action).toBe('remove');
    expect(result.patch.settings).toEqual({ ...source.settings, presetId: undefined, worldbookPresetId: undefined });
    expect(result.patch.scenario).toBe(scenario);
    expect(result.patch.auxScenarios).toEqual([scenario, source.auxScenarios[3]]);
    expect(result.preferencePatch).toEqual({ lastPresetId: undefined, lastWorldbookPresetId: undefined });
    expect(source).toEqual(before);
  });

  it.each([{ source: 'preset' as const }, { presetId: 'arena-classic' }, { id: 'preset-scenario' }])('clears each legacy preset main-scenario marker %j on removal', marker => {
    const source = session(); source.settings.presetId = 'arena-classic'; source.scenario = { ...scenario, ...marker }; delete source.auxScenarios;
    expect(projectMagicTeaPartyPreset(source, 'arena-classic')!.patch).toMatchObject({ scenario: undefined, auxScenarios: [] });
  });

  it('switches presets rather than removing the old one and rejects unknown IDs without a patch', () => {
    const source = session(); source.settings.presetId = 'arena-classic';
    expect(projectMagicTeaPartyPreset(source, 'arena-daily')!.action).toBe('apply');
    expect(projectMagicTeaPartyPreset(source, 'not-a-preset')).toBeNull();
  });
});
