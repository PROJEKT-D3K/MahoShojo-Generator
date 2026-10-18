import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ROOM_GENERATION_START_GATE_VERSION, type RoomGenerationAdmission } from '@mahoshojo/hosted-api/arena-generation/service';
import { createNodeArenaNoProviderCancellationRecorder, createNodeArenaRejectedTerminalRecorder } from '../src/arena-generation/d1-finalization';
import type { NodeDataD1Client } from '../src/node-runtime/data-ports';

type Database = {
  exec(_sql: string): void;
  prepare(_sql: string): { all(..._params: unknown[]): Record<string, unknown>[]; run(..._params: unknown[]): { changes: number | bigint } };
  close(): void;
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (_path: string) => Database };
const schema = readFileSync(new URL('../../../apps/web/lib/database/schema.sql', import.meta.url), 'utf8');
const admission: RoomGenerationAdmission = {
  version: ROOM_GENERATION_START_GATE_VERSION, roomId: 'room-1', roomEpoch: 'epoch-1',
  hostUserId: 'host-1', hostAccountUserId: 42, generationId: 'generation-1', generationRequestId: 'request-1',
  attempt: 1, configRevision: 7, snapshotDigest: `sha256:${'a'.repeat(64)}`,
  generationPayloadDigest: `sha256:${'b'.repeat(64)}`, mode: 'kizuna', startedAt: '2026-08-27T16:01:00.000Z',
};
const now = () => new Date('2026-08-27T16:02:00.000Z');
const fixture = () => {
  const database = new DatabaseSync(':memory:');
  const definition = /CREATE TABLE IF NOT EXISTS battle_report_generations \([\s\S]*?\n\);/u.exec(schema)?.[0];
  if (!definition) throw new Error('Missing actual generation schema');
  database.exec(definition);
  let writeFailure: 'none' | 'before' | 'after' = 'none';
  let readFailure = false;
  const client: NodeDataD1Client = { prepare(sql) {
    const statement = database.prepare(sql);
    let params: unknown[] = [];
    const bound = {
      bind(...next: unknown[]) { params = next; return bound; },
      async all() {
        if (readFailure) throw new Error('synthetic unavailable read');
        return { success: true, results: statement.all(...params), meta: {} };
      },
      async run() {
        if (writeFailure === 'before') throw new Error('synthetic write failed');
        const result = statement.run(...params);
        if (writeFailure === 'after') throw new Error('synthetic lost write acknowledgement');
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
    };
    return bound;
  } };
  return {
    database, client,
    failWrites(value: typeof writeFailure) { writeFailure = value; },
    failReads(value: boolean) { readFailure = value; },
    rows: () => database.prepare('SELECT * FROM battle_report_generations').all(),
    record: () => createNodeArenaNoProviderCancellationRecorder({ getD1Client: () => client, now }).record({ admission }),
  };
};

describe('Room no-provider cancellation durable record (actual SQLite schema)', () => {
  it('writes the frozen terminal-only row and is idempotent on the unique generation ID', async () => {
    const f = fixture();
    try {
      expect(await f.record()).toEqual({ kind: 'recorded' });
      expect(await f.record()).toEqual({ kind: 'recorded' });
      expect(f.rows()).toHaveLength(1);
      expect(f.rows()[0]).toMatchObject({ status: 'aborted', generation_mode: 'stream', endpoint: 'api/arena/generate-stream',
        mode: 'kizuna', pvp_room_id: 'room-1', pvp_match_id: 'generation-1', pvp_round_id: 'attempt-1', output_chars: 0, output_bytes: 0 });
      expect(JSON.parse(String(f.rows()[0]!.extra_json))).toEqual({
        generationRequestId: 'request-1', generationOwnerHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        generationPayloadHash: 'b'.repeat(64), generationTerminalStatus: 'cancelled', finalizationCompleted: true,
        errorCode: 'USER_CANCELLED', resultRef: null, cancelledBeforeProvider: 'room-generation-no-provider-cancel-v1',
      });
    } finally { f.database.close(); }
  });

  it('reconciles a lost write acknowledgement by exact readback, and retries an unknown outcome safely', async () => {
    const f = fixture();
    try {
      f.failWrites('after');
      expect(await f.record()).toEqual({ kind: 'recorded' });
      f.failReads(true);
      expect(await f.record()).toEqual({ kind: 'unknown' });
      f.failReads(false); f.failWrites('none');
      expect(await f.record()).toEqual({ kind: 'recorded' });
      expect(f.rows()).toHaveLength(1);
    } finally { f.database.close(); }
  });

  it('fails closed without D1 or with an uncommitted write and no row', async () => {
    expect(await createNodeArenaNoProviderCancellationRecorder({ getD1Client: () => null }).record({ admission })).toEqual({ kind: 'unavailable' });
    const f = fixture();
    try {
      f.failWrites('before');
      expect(await f.record()).toEqual({ kind: 'unknown' });
      expect(f.rows()).toHaveLength(0);
    } finally { f.database.close(); }
  });

  it.each(['generationOwnerHash', 'generationRequestId', 'generationPayloadHash'])('never accepts an existing row with wrong %s', async (field) => {
    const f = fixture();
    try {
      await f.record();
      const extra = JSON.parse(String(f.rows()[0]!.extra_json)) as Record<string, unknown>;
      extra[field] = 'wrong';
      f.database.prepare('UPDATE battle_report_generations SET extra_json=? WHERE id=?').run(JSON.stringify(extra), admission.generationId);
      expect(await f.record()).toEqual({ kind: 'conflict' });
      expect(JSON.parse(String(f.rows()[0]!.extra_json))[field]).toBe('wrong');
    } finally { f.database.close(); }
  });

  it.each(['cancel', 'rejection'])('preserves the first actual terminal when %s wins the unique-ID race', async (winner) => {
    const f = fixture();
    try {
      const reject = () => createNodeArenaRejectedTerminalRecorder({ getD1Client: () => f.client, now }).record({
        generationId: admission.generationId, generationRequestId: admission.generationRequestId,
        actorKey: 'pvp-room:room-1', payloadHash: 'b'.repeat(64), mode: 'kizuna',
        startedAt: admission.startedAt, generationMode: 'stream', endpoint: 'api/arena/generate-stream',
        pvpContext: { roomId: 'room-1', matchId: 'generation-1', roundId: 'attempt-1' },
        code: 'CONTENT_POLICY_VIOLATION', stage: 'preflight',
      });
      if (winner === 'cancel') {
        expect(await f.record()).toEqual({ kind: 'recorded' });
        expect(await reject()).toEqual({ kind: 'conflict' });
      } else {
        expect(await reject()).toEqual({ kind: 'recorded' });
        expect(await f.record()).toEqual({ kind: 'already-terminal' });
      }
      expect(f.rows()).toHaveLength(1);
      expect(f.rows()[0]!.status).toBe(winner === 'cancel' ? 'aborted' : 'failed');
    } finally { f.database.close(); }
  });
});
