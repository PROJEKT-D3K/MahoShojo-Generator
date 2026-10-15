import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/desktop-room-ipc.json';
import proposals from '../fixtures/desktop-room-proposals.json';
import {
  DESKTOP_ROOM_IPC_COMMANDS,
  DesktopRoomAcceptedResponseSchema,
  DesktopRoomActionSchema,
  DesktopRoomAttachResponseSchema,
  DesktopRoomBatchSchema,
  DesktopRoomHttpOperationSchema,
  DesktopRoomNotificationSchema,
  DesktopRoomProposalObservationSchema,
  DesktopRoomProposalTrackingEndedSchema,
  DesktopRoomRequestSchema,
  parseDesktopRoomBatch, getDesktopRoomHttpOperation,
} from '../src/desktop-room-ipc';
import { DESKTOP_ROOM_SESSION_LIMITS } from '../src/desktop-room-session';
import { jsonUtf8ByteLength } from '../src/wire-size';

const cases = [
  ['proposalSubmit', 'proposal-submit'],
  ['proposalWithdraw', 'proposal-withdraw'],
  ['proposalResolve', 'proposal-resolve'],
] as const;
const action = (operation: (typeof cases)[number][0], kind: (typeof cases)[number][1]): Record<string, unknown> => ({
  kind,
  roomId: 'room_01JARENAEXAMPLE',
  ...(operation === 'proposalSubmit' ? {} : { proposalId: 'desktop-proposal-1' }),
  request: structuredClone(proposals[operation].request.request),
});
const batch = (event: unknown) => ({ ...fixture.pulls[0].batch, event });

describe('closed Native proposal IPC', () => {
  it('uses the existing command family and producer operation names with canonical action targets', () => {
    expect(Object.values(DESKTOP_ROOM_IPC_COMMANDS)).toHaveLength(4);
    for (const [operation, kind] of cases) {
      expect(DesktopRoomHttpOperationSchema.parse(operation)).toBe(operation);
      const value = action(operation, kind);
      const parsed = DesktopRoomActionSchema.parse(value);
      expect(parsed).toEqual(value);
      if (parsed.kind === 'proposal-submit' || parsed.kind === 'proposal-withdraw' || parsed.kind === 'proposal-resolve') expect(getDesktopRoomHttpOperation(parsed)).toBe(operation);
      const request = { handle: fixture.attach.handle, request: value };
      expect(DesktopRoomRequestSchema.parse(request)).toEqual(request);
      for (const key of ['url', 'method', 'cookie', 'headers', 'role', 'authorUserId', 'createdAt']) {
        expect(DesktopRoomRequestSchema.safeParse({ ...request, [key]: true }).success).toBe(false);
        expect(DesktopRoomActionSchema.safeParse({ ...value, [key]: true }).success).toBe(false);
        expect(DesktopRoomActionSchema.safeParse({ ...value, request: { ...value.request as object, [key]: true } }).success).toBe(false);
      }
      expect(DesktopRoomActionSchema.safeParse({ ...value, kind: operation }).success).toBe(false);
      for (const id of ['房间 提案😀', "a?b#c&d+e=f:@$;,[]!~*'()_-.", 'a\tb', 'a\0b', '😀'.repeat(128)]) {
        const valid = { ...value, roomId: id, ...(operation === 'proposalSubmit'
          ? { request: { ...value.request as object, proposalId: id } } : { proposalId: id }) };
        expect(DesktopRoomActionSchema.parse(valid)).toEqual(valid);
      }
      for (const id of ['', '.', '..', ' x', 'x ', '\ufeffx', 'x\u3000', 'a/b', 'a\\b', '%2e', '%252f', '100%', '😀'.repeat(129), '\ud800']) {
        expect(DesktopRoomActionSchema.safeParse({ ...value, roomId: id }).success).toBe(false);
        expect(DesktopRoomActionSchema.safeParse({ ...value, ...(operation === 'proposalSubmit'
          ? { request: { ...value.request as object, proposalId: id } } : { proposalId: id }) }).success).toBe(false);
      }
    }
  });

  it('preserves proposal merge DTO rules and counts original bytes before trim', () => {
    const submit = action('proposalSubmit', 'proposal-submit');
    expect(DesktopRoomActionSchema.safeParse({ ...submit, request: { ...submit.request as object, baseRevision: 0 } }).success).toBe(true);
    expect(DesktopRoomActionSchema.safeParse({ ...submit, request: { ...submit.request as object, changes: [] } }).success).toBe(false);
    const resolve = action('proposalResolve', 'proposal-resolve');
    const original = { expectedRoomEpoch: 'epoch_01JARENA', resolution: 'accept-selected', selectedChangeIds: ['guidance-1'] };
    expect(DesktopRoomActionSchema.safeParse({ ...resolve, request: original }).success).toBe(true);
    expect(DesktopRoomActionSchema.safeParse({ ...resolve, request: { ...original, overrideChangeIds: ['guidance-1'] } }).success).toBe(false);
    expect(DesktopRoomActionSchema.safeParse({ ...resolve, request: { ...original, overrideChangeIds: ['guidance-1'], expectedRevision: 7 } }).success).toBe(true);
    for (const overrides of [['missing'], ['guidance-1', 'guidance-1']]) {
      expect(DesktopRoomActionSchema.safeParse({ ...resolve, request: { ...original, overrideChangeIds: overrides, expectedRevision: 7 } }).success).toBe(false);
    }
    expect(DesktopRoomActionSchema.safeParse({ ...resolve, request: { ...original, resolution: 'reject' } }).success).toBe(false);
    const withdraw = action('proposalWithdraw', 'proposal-withdraw');
    const body = withdraw.request as { expectedRoomEpoch: string };
    const padding = DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes - jsonUtf8ByteLength(body);
    body.expectedRoomEpoch = ' '.repeat(padding) + body.expectedRoomEpoch;
    expect(DesktopRoomActionSchema.safeParse(withdraw).success).toBe(true);
    body.expectedRoomEpoch = ' ' + body.expectedRoomEpoch;
    expect(DesktopRoomActionSchema.safeParse(withdraw).success).toBe(false);
  });

  it('delivers strictly checked summary receipts and complete consistent resolution snapshots', () => {
    for (const [operation] of cases) {
      const event = { kind: 'http-result', requestId: 'request-1', operation, response: proposals[operation].success };
      const valid = batch(event);
      expect(DesktopRoomBatchSchema.parse(valid)).toEqual(valid);
      expect(parseDesktopRoomBatch(valid, 42)).toEqual(valid);
      expect(() => parseDesktopRoomBatch(valid, 43)).toThrow();
      const result = proposals[operation].success.result;
      expect(DesktopRoomBatchSchema.safeParse(batch({ ...event, response: { ...event.response, result: { ...result, extra: true } } })).success).toBe(false);
      for (const field of ['controlSeq', 'revision']) {
        expect(DesktopRoomBatchSchema.safeParse(batch({ ...event, response: { ...event.response, result: { ...result, [field]: Number.MAX_SAFE_INTEGER + 1 } } })).success).toBe(false);
      }
    }
    const result = proposals.proposalResolve.success.result;
    const check = (replacement: unknown) => DesktopRoomBatchSchema.safeParse(batch({ kind: 'http-result', requestId: 'request-1', operation: 'proposalResolve', response: {
      ...proposals.proposalResolve.success, result: replacement,
    } })).success;
    expect(check({ ...result, snapshot: undefined })).toBe(false);
    expect(check({ ...result, sharedConfig: undefined })).toBe(false);
    expect(check({ ...result, snapshot: { ...result.snapshot, controlSeq: result.controlSeq + 1 } })).toBe(false);
    expect(check({ ...result, sharedConfig: { ...result.sharedConfig, userGuidance: 'different' } })).toBe(false);
    for (const status of ['accepted', 'partially_accepted', 'rejected']) expect(check({ ...result, status })).toBe(true);
    expect(check({ ...result, status: 'withdrawn' })).toBe(false);
    expect(check({ ...result, result: 'idempotent' })).toBe(false);
  });

  it('keeps unknown proposal intents and errors inside existing bounded envelopes', () => {
    for (const [operation] of cases) {
      const pendingIntent = { intentId: 'intent-1', operation, roomId: 'room_01JARENAEXAMPLE' };
      expect(DesktopRoomAttachResponseSchema.safeParse({ ...fixture.attach, pendingIntent }).success).toBe(true);
      expect(DesktopRoomAttachResponseSchema.safeParse({ ...fixture.attach, pendingIntent: { ...pendingIntent, roomId: null } }).success).toBe(false);
      expect(DesktopRoomBatchSchema.safeParse(batch({ kind: 'mutation-unknown', ...pendingIntent })).success).toBe(true);
      const revoked = { ...fixture.revokedNotifications[0], operation };
      expect(DesktopRoomNotificationSchema.safeParse(revoked).success).toBe(true);
      expect(DesktopRoomNotificationSchema.safeParse({ ...revoked, error: { ...revoked.error, outcome: 'not-applicable' } }).success).toBe(false);
    }
  });

  it('observes only closed evidence and distinguishes it from a receipt or cancellation', () => {
    const pending = { observation: 'pending', linked: true, settle: false, outcome: null, terminalStatus: null };
    const observations = [pending,
      { ...pending, observation: 'absent' },
      { ...pending, observation: 'conflict', linked: false },
      { ...pending, observation: 'scope-changed', linked: false },
      { ...pending, observation: 'target-unavailable', linked: false },
      { ...pending, observation: 'submitted', settle: true, outcome: 'satisfied' },
      { ...pending, observation: 'terminal', settle: true, outcome: 'scope-unverified', terminalStatus: 'partially_accepted' },
    ];
    for (const observation of observations) {
      expect(DesktopRoomProposalObservationSchema.parse(observation)).toEqual(observation);
      const event = { kind: 'proposal-observation', intentId: 'intent-1', observation };
      expect(DesktopRoomBatchSchema.parse(batch(event))).toEqual(batch(event));
      expect(DesktopRoomBatchSchema.safeParse(batch({ ...event, success: true })).success).toBe(false);
      expect(DesktopRoomBatchSchema.safeParse(batch({ ...event, observation: { ...observation, applied: true } })).success).toBe(false);
      for (const field of ['observation', 'linked', 'settle', 'outcome', 'terminalStatus']) {
        const missing = { ...observation }; delete missing[field as keyof typeof missing];
        expect(DesktopRoomProposalObservationSchema.safeParse(missing).success).toBe(false);
      }
    }
    for (const invalid of [
      { ...pending, settle: true }, { ...pending, outcome: 'satisfied' },
      { ...pending, terminalStatus: 'withdrawn' }, { ...pending, observation: 'conflict' },
      { ...pending, observation: 'submitted', settle: true, outcome: 'different' },
    ]) expect(DesktopRoomProposalObservationSchema.safeParse(invalid).success).toBe(false);
    const action = { kind: 'end-proposal-tracking', intentId: 'intent-1' };
    expect(DesktopRoomActionSchema.parse(action)).toEqual(action);
    const ended = { kind: 'proposal-tracking-ended', intentId: 'intent-1', ended: true };
    expect(DesktopRoomProposalTrackingEndedSchema.parse(ended)).toEqual(ended);
    expect(DesktopRoomAcceptedResponseSchema.safeParse(ended).success).toBe(false);
    for (const key of ['cancel', 'applied', 'roomId', 'request']) {
      expect(DesktopRoomActionSchema.safeParse({ ...action, [key]: true }).success).toBe(false);
      expect(DesktopRoomProposalTrackingEndedSchema.safeParse({ ...ended, [key]: true }).success).toBe(false);
    }
    expect(DesktopRoomProposalTrackingEndedSchema.safeParse({ ...ended, ended: false }).success).toBe(false);
  });
});
