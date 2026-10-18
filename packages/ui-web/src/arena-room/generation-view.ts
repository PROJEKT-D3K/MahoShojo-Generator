export type RoomGenerationPhase = 'cancelled' | 'completed' | 'failed' | 'idle' | 'resyncing'
  | 'running' | 'starting' | 'unavailable' | 'unknown';

/** Display-only projection; request ownership, scope and recovery stay with the host. */
export type RoomGenerationView = {
  readonly phase: RoomGenerationPhase;
  readonly markdown: string;
  readonly gap: {
    readonly expectedChunkSeq: number;
    readonly receivedChunkSeq: number;
  } | null;
  readonly finalAuthoritative: boolean;
  readonly generationRecordId: string | null;
  readonly errorCode: string | null;
  readonly recoveryCode?: string | null;
};
