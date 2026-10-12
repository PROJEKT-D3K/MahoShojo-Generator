import { describe, expect, it } from 'vitest';
import ready from '../fixtures/arena-generation-ranking.json';
import { parseGenerationRankingResponse, requireGenerationRankingResponse } from '../src/arena-generation-ranking';
import { parseDesktopArenaHostedSseBlock } from '../src/desktop-arena-hosted';

const wire = (data: unknown) => `id: 2-0\nevent: ranking\ndata: ${JSON.stringify(data)}\n\n`;
describe('shared public generation ranking projection', () => {
  it.each([ready, { ...ready, participants: [] },
    { success: true, generationId: 'legacy-generation-id', state: 'pending', message: '等待结算' },
    { success: false, generationId: ' legacy-id ', error: '读取失败' },
  ])('preserves existing response branches and legacy nonempty IDs', value => {
    expect(parseGenerationRankingResponse(value)).toEqual(value);
    expect(parseDesktopArenaHostedSseBlock(wire(value))).toEqual({ id: '2-0', event: 'ranking', data: value });
  });
  it('strips private fields at every public object boundary', () => {
    const value = structuredClone(ready), secret = { secret: 'secret-canary', generation: { ip: 'secret-canary' } };
    const participant = value.participants[0]!;
    const input = { ...value, ...secret, snapshot: { ...value.snapshot, ...secret }, participants: [{ ...participant, ...secret,
      queues: { ...participant.queues, ...secret, strict: { ...participant.queues.strict, ...secret }, free: { ...participant.queues.free, ...secret } } }] };
    expect(requireGenerationRankingResponse(input)).toEqual(ready);
    expect(JSON.stringify(parseDesktopArenaHostedSseBlock(wire(input)))).not.toContain('secret-canary');
  });
  it.each([null, [], 7, true, 'private-canary', {}, { ...ready, generationId: ' ' },
    { ...ready, participants: {} }, { ...ready, snapshot: {} },
    { ...ready, participants: [{ ...ready.participants[0], queues: { strict: {}, free: {} } }] },
  ])('isolates malformed business feedback without losing the complete cursor', value => {
    expect(parseGenerationRankingResponse(value)).toBeNull();
    expect(() => requireGenerationRankingResponse(value)).toThrow('ARENA_GENERATION_RANKING_RESPONSE_INVALID');
    expect(parseDesktopArenaHostedSseBlock(wire(value))).toEqual({ id: '2-0', event: 'ranking', data: null });
  });
  it.each([-1.5, 0, 1.25, 1e308])('preserves finite numeric domain %s without integer/nonnegative restrictions', value => {
    const input = structuredClone(ready); input.participants[0]!.queues.strict.games = value;
    expect(parseGenerationRankingResponse(input)).toEqual(input);
  });
  it.each(['missing', 'pending', 'applied', 'skipped', 'failed'])('preserves the server queue result %s rather than inferring score authority', eventStatus => {
    const input = structuredClone(ready); input.participants[0]!.queues.strict.eventStatus = eventStatus;
    expect(parseGenerationRankingResponse(input)).toEqual(input);
  });
  it.each([NaN, Infinity, -Infinity])('rejects non-finite numeric input (v3 already rejected NaN): %s', value => {
    const input = structuredClone(ready); input.participants[0]!.queues.strict.rating = value;
    expect(parseGenerationRankingResponse(input)).toBeNull();
  });
  it('keeps overflowed JSON feedback unavailable and transport corruption fatal', () => {
    const overflow = wire(ready).replace('"rating":1012', '"rating":1e400');
    expect(parseDesktopArenaHostedSseBlock(overflow)).toMatchObject({ id: '2-0', event: 'ranking', data: null });
    for (const block of ['id: 2-0\nevent: ranking\ndata: {\n\n', wire(ready).replace('2-0', 'bad-id'),
      wire(ready).replace('event: ranking', 'event: unknown'), wire(ready).slice(0, -1)]) {
      expect(() => parseDesktopArenaHostedSseBlock(block)).toThrow();
    }
  });
});
