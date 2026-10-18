import { describe, expect, it } from 'vitest';
import { applyMagicTeaPartyRoleDraft, readMagicTeaPartyRoleDraft, sameMagicTeaPartyRoleSource } from '../src/magic-tea-party/role-editor';
import type { MagicTeaPartyRole } from '../src/magic-tea-party/types';
const role = (card: Record<string, unknown>): MagicTeaPartyRole => ({ id: 'r', name: '旧名', notes: '原备注', source: 'local',
  signature: 'opaque-old-signature', isNative: false, origin: { fileName: 'original.json' }, card });
const state = { summary: '旧摘要', fields: { hp: 7 }, extension: ['保真', { arbitrary: true }] };
describe('local tea role basic projection', () => {
  it.each([{ current_state: state }, { current_state: JSON.stringify(state) }, { currentState: state }, { currentState: JSON.stringify(state) }])('preserves state and card extensions from every supported representation: %j', shape => {
    const source = role({ templateId: '通用角色', name: '旧名', content: '正文', extension: { untouched: ['😀', null] }, ...shape });
    const before = structuredClone(source);
    expect(readMagicTeaPartyRoleDraft(source)).toEqual({ name: '旧名', notes: '原备注', currentState: '旧摘要' });
    const result = applyMagicTeaPartyRoleDraft(source, { name: ' 新名 ', notes: ' 新备注 ', currentState: ' 新摘要 ' }, 'now');
    expect(result).toMatchObject({ name: '新名', notes: '新备注', signature: source.signature, isNative: false, source: 'local', origin: source.origin,
      card: { ...source.card, name: '新名', current_state: { ...state, summary: '新摘要', updated_at: 'now' } } });
    expect(source).toEqual(before);
  });
  it('keeps legacy state bytes on unrelated edits and clears a camel-case summary explicitly', () => {
    const raw = ' { "summary": "旧摘要", "extension": [1] } ';
    const source = role({ codename: '旧名', currentState: raw, signature: 'card signature' });
    const result = applyMagicTeaPartyRoleDraft(source, { ...readMagicTeaPartyRoleDraft(source), name: '新代号', notes: '' }, 'now');
    expect(result.card).toEqual({ ...source.card, codename: '新代号' }); expect(result.notes).toBeUndefined();
    const cleared = applyMagicTeaPartyRoleDraft(source, { ...readMagicTeaPartyRoleDraft(source), currentState: '' }, 'now');
    expect(cleared.card.current_state).toEqual({ summary: '', extension: [1], updated_at: 'now' });
    expect(cleared.card.currentState).toBe(raw); expect(readMagicTeaPartyRoleDraft(cleared).currentState).toBe('');
  });
  it('rejects blank names without modifying the source', () => {
    const source = role({ name: '旧名' });
    expect(() => applyMagicTeaPartyRoleDraft(source, { name: ' \n ', notes: '', currentState: '' }, 'now')).toThrow('角色名称不能为空');
    expect(source.card).toEqual({ name: '旧名' });
  });
  it('compares complete source data without stripping extension keys or normalizing UTF-16', () => {
    const source = { ...role({ name: '旧名', text: '\ud800', optional: undefined }), extension: { retained: true } };
    expect(sameMagicTeaPartyRoleSource(source, structuredClone(source))).toBe(true);
    expect(sameMagicTeaPartyRoleSource(source, JSON.parse(JSON.stringify(source)))).toBe(false);
    expect(sameMagicTeaPartyRoleSource(source, { ...source, card: { ...source.card, text: '\ufffd' } })).toBe(false);
    expect(sameMagicTeaPartyRoleSource([undefined], [])).toBe(false);
  });
});
