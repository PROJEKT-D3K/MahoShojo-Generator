import { describe, expect, test, vi } from 'vitest';
import {
  createD1HttpTransport, createHttpD1Client, validateD1ReturningResult,
  type D1HttpTransport,
} from '@mahoshojo/hosted-runtime/d1-http-client';

const valid = { success: true, results: [{ id: 'r1' }], meta: { changes: 1 } };
const invalid: Array<[string, unknown]> = [
  ['null row', { ...valid, results: [null] }],
  ['number row', { ...valid, results: [3] }],
  ['array row', { ...valid, results: [['r1']] }],
  ['raw result shape', { ...valid, results: { rows: [['r1']], columns: ['id'] } }],
  ['missing results', { success: true, meta: { changes: 1 } }],
  ['missing meta', { success: true, results: [] }],
  ['missing changes', { ...valid, results: [], meta: {} }],
  ['empty positive changes', { ...valid, results: [] }],
  ['negative changes', { ...valid, meta: { changes: -1 } }],
  ['fraction changes', { ...valid, meta: { changes: 0.5 } }],
  ['string changes', { ...valid, meta: { changes: '1' } }],
  ['nonempty zero changes', { ...valid, meta: { changes: 0 } }],
];
const transport = (fetcher: typeof fetch) => createD1HttpTransport({
  kind: 'cloudflare-api', queryUrl: 'https://d1.example.test/query', rawUrl: 'https://d1.example.test/raw', fetch: fetcher,
});

describe('explicit strict RETURNING receipt', () => {
  test.each(invalid)('%s is unknown after one dispatch, never normalized to zero writes', async (_name, receipt) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result: [receipt] }));
    await expect(createHttpD1Client(transport(fetcher)).prepare('DELETE FROM cards RETURNING id').allStrict())
      .rejects.toMatchObject({ code: 'D1_INDETERMINATE_OUTCOME' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  test('only valid empty rows plus numeric zero changes establish zero writes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result: [{ ...valid, results: [], meta: { changes: 0 } }] }));
    expect(await createHttpD1Client(transport(fetcher)).prepare('DELETE FROM cards RETURNING id').allStrict())
      .toEqual({ success: true, results: [], meta: { changes: 0 } });
  });
  test('positive changes may include cascading or triggered changes, not just returned IDs', () => {
    expect(validateD1ReturningResult({ ...valid, meta: { changes: 8 } }).results).toEqual([{ id: 'r1' }]);
  });
  test('explicit strict receipt intent never opts into safe-read retries or depends on SQL guessing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(transport(fetcher).query('SELECT id FROM cards', [], { strictReturning: true, retry: 'safe-read' }))
      .rejects.toMatchObject({ code: 'D1_INDETERMINATE_OUTCOME' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  test('an injected transport cannot bypass receipt validation or authorize a retry', async () => {
    const query = vi.fn().mockResolvedValue({ success: true, result: [{ ...valid, results: [null] }] });
    const injected = { query, queryRaw: vi.fn(), queryBatch: vi.fn() } as D1HttpTransport;
    await expect(createHttpD1Client(injected).prepare('DELETE FROM cards RETURNING id').bind('r1').allStrict())
      .rejects.toMatchObject({ code: 'D1_INDETERMINATE_OUTCOME' });
    expect(query).toHaveBeenCalledExactlyOnceWith('DELETE FROM cards RETURNING id', ['r1'], { retry: 'none', strictReturning: true });
  });
});
