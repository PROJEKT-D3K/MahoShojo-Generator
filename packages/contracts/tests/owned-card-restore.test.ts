import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/desktop-cloud.json';
import { OwnedDataCardRestoreAcknowledgementSchema } from '../src/data-cards';
import { DesktopCardLibraryRequestSchema, DesktopCardLibraryRouteIdSchema } from '../src/desktop-cloud';

describe('restore fixed-route golden contract', () => {
  it('pins a single authenticated POST endpoint', () => {
    expect(fixture.cardLibrary.routes['data-cards.restore']).toEqual({ method: 'POST', path: '/api/data-cards/restore-owned', auth: 'required' });
    expect(DesktopCardLibraryRouteIdSchema.safeParse('data-cards.restore').success).toBe(true);
  });
  it('accepts strict requests and rejects URL, query, owner and snapshot drift', () => {
    for (const wire of fixture.cardLibrary.restoreRequests.valid) expect(DesktopCardLibraryRequestSchema.safeParse(wire).success, JSON.stringify(wire)).toBe(true);
    for (const wire of fixture.cardLibrary.restoreRequests.invalid) expect(DesktopCardLibraryRequestSchema.safeParse(wire).success, JSON.stringify(wire)).toBe(false);
  });
  it('accepts only exact acknowledgement identity, version and status', () => {
    const valid = (wire: { request: { expectedUserId: number; body: { id: string; version: string } }; status: number; body: unknown }) => {
      const ack = OwnedDataCardRestoreAcknowledgementSchema.safeParse(wire.body);
      return wire.status === 200 && ack.success && ack.data.ownerUserId === wire.request.expectedUserId && ack.data.id === wire.request.body.id && ack.data.version === wire.request.body.version;
    };
    for (const wire of fixture.cardLibrary.restoreResponses.valid) expect(valid(wire), JSON.stringify(wire)).toBe(true);
    for (const wire of fixture.cardLibrary.restoreResponses.invalid) expect(valid(wire), JSON.stringify(wire)).toBe(false);
  });
});
