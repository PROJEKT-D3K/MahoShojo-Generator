import { describe, expect, it } from 'vitest';
import { canResolveBattleStoryRoles, type BattleStoryRoleResolution } from '../src/arena-story-completed-output';

describe('completed story role decision permission', () => {
  const base = { role: { status: 'unresolved' } as BattleStoryRoleResolution, contextCurrent: true, roleBusy: false, commitFrozen: false };
  it('only unresolved original-context single-flight unfrozen output permits resolution', () => {
    expect(canResolveBattleStoryRoles(base)).toBe(true);
    expect(canResolveBattleStoryRoles({ ...base, contextCurrent: false })).toBe(false);
    expect(canResolveBattleStoryRoles({ ...base, roleBusy: true })).toBe(false);
    expect(canResolveBattleStoryRoles({ ...base, commitFrozen: true })).toBe(false);
  });
  it.each<BattleStoryRoleResolution>([
    { status: 'not-requested' }, { status: 'accepted' }, { status: 'http-failure', warning: 'HTTP failed' },
    { status: 'user-kept-original', warning: 'explicit choice' }, { status: 'legacy-no-generation', warning: 'legacy' },
  ])('$status never permits another role request', (role) => {
    expect(canResolveBattleStoryRoles({ ...base, role })).toBe(false);
  });
});
