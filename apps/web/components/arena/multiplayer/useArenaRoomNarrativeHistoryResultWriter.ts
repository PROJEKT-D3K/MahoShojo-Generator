'use client';

import { useEffect, useMemo, useRef } from 'react';

import { captureAuthIdentity, type AuthIdentity } from '@/lib/auth-identity';

import type { ArenaRoomControllerState } from '@/lib/arena-room/controller';
import {
  appendArenaNarrativeHistoryResult,
  selectArenaRoomNarrativeHistoryResultWrite,
  type ArenaNarrativeHistoryResultWrite,
} from '@/lib/arena-room/narrative-history-runtime';

type NarrativeHistoryWriter = (payload: ArenaNarrativeHistoryResultWrite, commitIf?: () => boolean) => Promise<void>;

export const useArenaRoomNarrativeHistoryResultWriter = (
  state: ArenaRoomControllerState,
  write: NarrativeHistoryWriter = appendArenaNarrativeHistoryResult,
  suppliedIdentity?: AuthIdentity,
): void => {
  const identity = useMemo(() => suppliedIdentity ?? captureAuthIdentity(), [suppliedIdentity]);
  const lastWriteKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!identity.isCurrent()) return;
    const payload = selectArenaRoomNarrativeHistoryResultWrite(state);
    const session = state.session;
    if (!payload || !session) return;
    const writeKey = [
      identity.epoch,
      session.self.userId,
      session.roomId,
      session.roomEpoch,
      payload.generationId ?? state.generation.generationRecordId ?? 'unknown',
    ].join(':');
    if (lastWriteKeyRef.current === writeKey) return;
    lastWriteKeyRef.current = writeKey;
    void write(payload, () => identity.isCurrent());
  }, [identity, state, write]);
};
