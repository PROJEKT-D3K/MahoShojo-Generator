import { describe, expect, it } from 'vitest';
import { buildMagicTeaPartyChoicesPrompt, projectMagicTeaPartyChoices } from '../src/magic-tea-party';

const choices = [{ id: 'a', text: '喝茶' }, { id: 'b', text: '看看窗外' }];
const rawChoices = JSON.stringify({ type: 'choices', items: choices });

describe('manual Tea choices projection', () => {
  it('preserves completed choices, multi-block display and warning notices', () => {
    const rawText = [
      JSON.stringify({ type: 'choices', items: [{ id: 'first', text: '问候' }] }),
      JSON.stringify({ type: 'notice', level: 'warning', message: '按情景调整数量' }),
      rawChoices,
    ].join('\n');
    const result = projectMagicTeaPartyChoices({ rawText, completion: 'completed' });
    expect(result).toMatchObject({ status: 'done', choices, lastChoices: choices });
    expect(result.segments).toHaveLength(2);
    expect(result.notices).toMatchObject([{ level: 'warning', message: '按情景调整数量' }]);
    expect(result.content).toContain('- 问候');
    expect(result.content).toContain('- 喝茶');
    expect(result.error).toBeUndefined();
  });

  it.each(['stopped', 'failed', 'blocked'] as const)('never promotes a valid prefix after %s', (completion) => {
    const result = projectMagicTeaPartyChoices({ rawText: rawChoices, completion });
    expect(result).toMatchObject({ choices: [], lastChoices: null, status: completion === 'blocked' ? 'blocked' : 'error' });
    expect(result.segments).toEqual([{ type: 'choices', items: choices }]);
    expect(result.content).toBe('- 喝茶\n- 看看窗外');
    expect(result.error).toBeDefined();
  });

  it('error notices revoke all executable choices while retaining display', () => {
    const rawText = `${rawChoices}\n${JSON.stringify({ type: 'notice', level: 'error', code: 'story_error', message: '情景条件不满足' })}`;
    expect(projectMagicTeaPartyChoices({ rawText, completion: 'completed' })).toMatchObject({
      status: 'error', choices: [], lastChoices: null,
      error: { code: 'story_error', message: '情景条件不满足' },
      segments: [{ type: 'choices', items: choices }],
    });
  });

  it.each(['', '  ', '{broken', '普通正文', '{"type":"choices","items":[{"text":" "}]}'])('does not call empty or invalid choices successful: %j', (rawText) => {
    const result = projectMagicTeaPartyChoices({ rawText, completion: 'completed' });
    expect(result).toMatchObject({ status: 'error', choices: [], lastChoices: null });
    expect(result.content).toBe(rawText);
  });

  it('retains established repair/string-item compatibility without new count or ID restrictions', () => {
    const rawText = '{"type":"choices","items":["喝茶",]}';
    expect(projectMagicTeaPartyChoices({ rawText, completion: 'completed' })).toMatchObject({
      status: 'done', choices: [{ id: 'c1', text: '喝茶' }],
    });
  });

  it('does not expose summary/updates as side effects and falls back to their raw text', () => {
    const rawText = '{"type":"summary","text":"不可自动应用"}\n{"type":"updates","drafts":[{"characterName":"旅人","impact":"改变"}]}';
    const result = projectMagicTeaPartyChoices({ rawText, completion: 'completed' });
    expect(result).toMatchObject({ status: 'error', choices: [], lastChoices: null, content: rawText });
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('updates');
    expect(projectMagicTeaPartyChoices({ rawText: `${rawChoices}\n${rawText}`, completion: 'completed' }).choices).toEqual(choices);
  });
});

it('keeps Web default updates and accepts only a request-level Desktop override', () => {
  const session = {
    playerRoleId: null,
    settings: { providerId: 'test', modelId: 'test', writeArenaHistory: true, writeCurrentState: true,
      outputPlan: { choices: 'off' as const, summary: 'auto' as const, updates: 'auto' as const } },
  };
  const before = structuredClone(session);
  const input = { session, roles: [], messages: [] };
  expect(buildMagicTeaPartyChoicesPrompt(input)).toContain('- updates：on');
  expect(buildMagicTeaPartyChoicesPrompt({ ...input, updates: 'off' })).toContain('- updates：off');
  expect(buildMagicTeaPartyChoicesPrompt({ ...input, updates: 'off' })).toContain('- choices：on');
  expect(session).toEqual(before);
});
