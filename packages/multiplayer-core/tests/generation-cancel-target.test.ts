import { describe, expect, it } from 'vitest';
import service from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import generation from '@mahoshojo/contracts/fixtures/desktop-room-generation-read.json';
import { ArenaRoomSessionResponseSchema } from '@mahoshojo/contracts/arena-room';
import { captureArenaRoomGenerationCancelTarget, isArenaRoomGenerationCancelTargetCurrent } from '../src/generation-cancel-target';
const active = () => ArenaRoomSessionResponseSchema.parse({ ...service.operations.session.success.result, snapshot: { ...service.operations.session.success.result.snapshot, activeGeneration: { ...generation.operation.success.result.generation, state: 'running' } } });
describe('captured host cancel target', () => {
  it('freezes the active target and refuses retargeting, role loss or terminal state', () => {
    const session = active(), target = captureArenaRoomGenerationCancelTarget(session)!;
    expect(Object.isFrozen(target)).toBe(true); expect(isArenaRoomGenerationCancelTargetCurrent(target, session)).toBe(true);
    for (const patch of [{ roomEpoch: 'new' }, { roomId: 'other' }, { self: { ...session.self, role: 'member' } }, { snapshot: { ...session.snapshot, activeGeneration: { ...session.snapshot.activeGeneration!, attempt: 2 } } }, { snapshot: { ...session.snapshot, activeGeneration: { ...session.snapshot.activeGeneration!, state: 'cancelled' } } }]) {
      expect(isArenaRoomGenerationCancelTargetCurrent(target, { ...session, ...patch } as typeof session)).toBe(false);
    }
    expect(captureArenaRoomGenerationCancelTarget(null)).toBeNull();
  });
});
