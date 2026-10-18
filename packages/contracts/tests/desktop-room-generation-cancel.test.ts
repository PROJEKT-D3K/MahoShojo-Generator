import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/desktop-room-generation-read.json';
import { DesktopRoomGenerationCancelReceiptSchema, parseDesktopRoomSessionRequest, parseDesktopRoomSessionResponse } from '../src/desktop-room-session';
import { DesktopRoomActionSchema, DesktopRoomPendingIntentSchema, DesktopRoomEventSchema } from '../src/desktop-room-ipc';
const view = fixture.operation.success.result;
const receipt = (({ protocolVersion, roomId, roomEpoch, generation, status }) => ({ protocolVersion, roomId, roomEpoch, generation, status }))(view);
const target = { roomEpoch: view.roomEpoch, generationId: view.generation.generationId, attempt: view.generation.attempt };
describe('bounded Desktop host cancellation', () => {
  it('negotiates only the fixed small request and receipt', () => {
    const request = { desktopRoom: { version: 'desktop-room-session-v1', expectedUserId: 101 }, request: { expectedRoomEpoch: view.roomEpoch } };
    expect(parseDesktopRoomSessionRequest('generationCancel', request, 101)).toEqual(request);
    expect(parseDesktopRoomSessionResponse('generationCancel', { ...fixture.operation.success, result: receipt }, fixture.operation.success.desktopRoom.viewerUserId)).toHaveProperty('result', receipt);
    for (const extra of [{ markdown: 'x'.repeat(300_000) }, { result: view.result }, { finalAuthoritative: true }]) expect(DesktopRoomGenerationCancelReceiptSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
  });
  it.each([['reserved', 'starting'], ['running', 'running'], ['finalizing', 'running'], ['completed', 'completed'], ['failed', 'failed'], ['producer_lost', 'failed'], ['cancelled', 'cancelled']])('requires %s mirror %s', (status, state) => {
    expect(DesktopRoomGenerationCancelReceiptSchema.safeParse({ ...receipt, status, generation: { ...receipt.generation, state } }).success).toBe(true);
    expect(DesktopRoomGenerationCancelReceiptSchema.safeParse({ ...receipt, status, generation: { ...receipt.generation, state: state === 'failed' ? 'running' : 'failed' } }).success).toBe(false);
  });
  it('binds the public pending target exclusively to cancellation, including reload and unknown events', () => {
    const pending = { intentId: 'cancel-one', operation: 'generationCancel', roomId: view.roomId, generationTarget: target };
    expect(DesktopRoomPendingIntentSchema.parse(pending)).toEqual(pending);
    expect(DesktopRoomEventSchema.parse({ kind: 'mutation-unknown', ...pending })).toMatchObject(pending);
    for (const patch of [{ generationTarget: undefined }, { roomId: null }, { operation: 'close' }, { generationTarget: { ...target, attempt: 0 } }]) expect(DesktopRoomPendingIntentSchema.safeParse({ ...pending, ...patch }).success).toBe(false);
    const action = { kind: 'generation-cancel', roomId: view.roomId, generationId: target.generationId, expectedRoomEpoch: target.roomEpoch, expectedAttempt: target.attempt };
    expect(DesktopRoomActionSchema.parse(action)).toEqual(action);
    for (const patch of [{ generationId: '../other' }, { roomId: 'room/other' }, { expectedAttempt: 0 }, { providerKey: 'forbidden' }]) expect(DesktopRoomActionSchema.safeParse({ ...action, ...patch }).success).toBe(false);
  });
});
