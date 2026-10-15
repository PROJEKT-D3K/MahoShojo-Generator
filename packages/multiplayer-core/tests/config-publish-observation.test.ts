import { describe, expect, it } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { observeArenaRoomConfigPublish, type ArenaRoomConfigPublishTarget } from '../src';
const session = (): ArenaRoomSessionResponse => structuredClone(fixture.operations.create.success.result) as ArenaRoomSessionResponse;
const target = (): ArenaRoomConfigPublishTarget => { const s = session(); return { roomId: s.roomId, selfUserId: s.self.userId, request: {
  expectedRoomEpoch: s.roomEpoch, expectedRevision: s.snapshot.revision, expectedControlSeq: s.snapshot.controlSeq, sharedConfig: s.snapshot.sharedConfig!,
} }; };
describe('config publish observations never prove a POST outcome', () => {
  it.each([7, 8, 50])('revision %s only reports current target equality', revision => {
    const s = session(); s.snapshot.revision = revision;
    expect(observeArenaRoomConfigPublish(target(), s, true)).toBe('target-matches');
    s.snapshot.sharedConfig!.userGuidance = 'another setting';
    expect(observeArenaRoomConfigPublish(target(), s, true)).toBe('target-differs');
  });
  it('does not replace a missing original target with the current draft or authority', () => {
    expect(observeArenaRoomConfigPublish(null, session(), false)).toBe('unobserved');
    expect(observeArenaRoomConfigPublish(null, session(), true)).toBe('target-unavailable');
    expect(observeArenaRoomConfigPublish(target(), null, true)).toBe('authority-unavailable');
  });
  it.each(['room', 'epoch', 'user', 'role', 'membership'])('rejects changed %s scope', field => {
    const s = session();
    if (field === 'room') s.roomId = 'another-room';
    if (field === 'epoch') s.roomEpoch = 'another-epoch';
    if (field === 'user') s.self.userId = 'another-user';
    if (field === 'role') s.self.role = 'member';
    if (field === 'membership') s.self.membershipState = 'revoked';
    expect(observeArenaRoomConfigPublish(target(), s, true)).toBe('scope-changed');
  });
  it('uses shared semantic online version rules without mutating either snapshot', () => {
    const t = target(), s = session();
    const scenario = s.snapshot.sharedConfig!.scenario!;
    if (!('ref' in scenario)) throw new Error('Expected online fixture');
    scenario.ref.versionToken = 'new-observed-version';
    const before = structuredClone({ t, s });
    expect(observeArenaRoomConfigPublish(t, s, true)).toBe('target-matches');
    expect({ t, s }).toEqual(before);
  });
});
