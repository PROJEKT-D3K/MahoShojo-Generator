import { describe, expect, it } from 'vitest';
import { resolveMagicTeaPartyPlayerIdentity } from '../src/magic-tea-party/player-identity';

describe('current tea player identity', () => {
  const roles = [{ id: 'a', name: ' 角色 A ' }, { id: 'b', name: '' }];
  it('uses only a participating selected role, including its fallback name', () => {
    expect(resolveMagicTeaPartyPlayerIdentity({ roles, playerRoleId: 'a', userDisplayName: '玩家' }))
      .toEqual({ playerRoleId: 'a', speakerName: '角色 A' });
    expect(resolveMagicTeaPartyPlayerIdentity({ roles, playerRoleId: 'b' }))
      .toEqual({ playerRoleId: 'b', speakerName: 'b' });
  });
  it.each([undefined, null, '', 'removed'])('projects absent or orphaned selection %j without mutating inputs', playerRoleId => {
    const input = { roles, playerRoleId, userDisplayName: ' 玩家 ' };
    expect(resolveMagicTeaPartyPlayerIdentity(input)).toEqual({ playerRoleId: null, speakerName: '玩家' });
    expect(input.playerRoleId).toBe(playerRoleId); expect(input.roles).toBe(roles);
  });
  it('uses the unassigned fallback when no participants remain', () => {
    expect(resolveMagicTeaPartyPlayerIdentity({ roles: [], playerRoleId: 'a', userDisplayName: ' ' }))
      .toEqual({ playerRoleId: null, speakerName: '旅人' });
  });
});
