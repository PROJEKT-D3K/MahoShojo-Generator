import { describe, expect, it } from 'vitest';
import { projectDesktopRoleUpdates } from '../src/features/arena/role-update-presentation';
import type { ArenaSessionState } from '../src/features/arena/session';

type Input = Parameters<typeof projectDesktopRoleUpdates>[0];
const data = (impact: string) => ({ name: '同名', templateId: '通用角色', arena_history: { entries: [{ impact }] }, current_state: { summary: '当前状态' }, extra: { untouched: '完整字段' } });
const direct = (): Input => ({ hosted: null, hostedGenerationId: null, roleUpdates: { status: 'idle', message: null, items: [] }, candidates: {
  scopeKey: 'original', requestId: 'request', generationId: 'generation', occurredAt: '2026-10-21T00:00:00Z', narrativeHistory: null,
  characterEffects: [{ combatantIndex: 1, data: data('第二位') }, { combatantIndex: 0, data: data('第一位') }],
} });

describe('Desktop 角色更新结果投影', () => {
  it('Direct 使用 effect 快照；重名与结果重排不改变身份或完整下载数据', () => {
    const input = direct();
    const result = projectDesktopRoleUpdates(input);
    expect(result.map(item => item.impact)).toEqual(['第二位', '第一位']);
    expect(new Set(result.map(item => item.key)).size).toBe(2);
    expect(result[0]!.data).toBe(input.candidates!.characterEffects[0]!.data);
    expect(JSON.parse(JSON.stringify(result[0]!.data)).extra).toEqual({ untouched: '完整字段' });
    const reordered = projectDesktopRoleUpdates({ ...input, candidates: { ...input.candidates!, characterEffects: [...input.candidates!.characterEffects].reverse() } });
    expect(reordered.map(item => item.key)).toEqual(result.map(item => item.key).reverse());
    expect(result[0]!.typeLabel).toContain('未签名');
    expect(result[0]!.typeLabel).toContain('通用角色');
  });
  it('Hosted 使用更新结果而非残留 Direct candidates；恢复后不声称已验签', () => {
    const input: Input = { ...direct(), hosted: {} as ArenaSessionState['hosted'], hostedGenerationId: 'hosted-generation', roleUpdates: {
      status: 'completed', message: null, items: [{ combatantIndex: 0, isNative: true, data: { ...data('服务器变化'), signature: 'test-signature' } }],
    } };
    expect(projectDesktopRoleUpdates(input)).toHaveLength(1);
    expect(projectDesktopRoleUpdates(input)[0]).toMatchObject({ impact: '服务器变化' });
    expect(projectDesktopRoleUpdates(input)[0]!.typeLabel).toContain('官方签名（服务器更新）');
    const restored = projectDesktopRoleUpdates({ ...input, roleUpdates: { ...input.roleUpdates, status: 'restored' } });
    expect(restored[0]!.typeLabel).toContain('本机未验证');
    expect(restored[0]!.data).toBe(input.roleUpdates.items[0]!.data);
  });
});
