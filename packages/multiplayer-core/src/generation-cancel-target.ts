import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';

/** Captured at confirmation-open, never retargeted to a newer generation. */
export type ArenaRoomGenerationCancelTarget = Readonly<{
  roomId: string; roomEpoch: string; selfUserId: string; generationId: string; attempt: number;
}>;
export const captureArenaRoomGenerationCancelTarget = (session: ArenaRoomSessionResponse | null): ArenaRoomGenerationCancelTarget | null => {
  const generation = session?.snapshot.activeGeneration;
  if (!session || session.self.role !== 'host' || session.self.membershipState !== 'active'
    || !generation || !['starting', 'running'].includes(generation.state)) return null;
  return Object.freeze({ roomId: session.roomId, roomEpoch: session.roomEpoch, selfUserId: session.self.userId,
    generationId: generation.generationId, attempt: generation.attempt });
};
export const isArenaRoomGenerationCancelTargetCurrent = (target: ArenaRoomGenerationCancelTarget, session: ArenaRoomSessionResponse | null): boolean => {
  const current = captureArenaRoomGenerationCancelTarget(session);
  return !!current && current.roomId === target.roomId && current.roomEpoch === target.roomEpoch
    && current.selfUserId === target.selfUserId && current.generationId === target.generationId && current.attempt === target.attempt;
};
