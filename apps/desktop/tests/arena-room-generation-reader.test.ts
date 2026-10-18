import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DesktopGenerationReader } from '../src/platform/arena-room-generation-reader';

const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-room-generation-read.json', import.meta.url), 'utf8'));
const identity = fixture.descriptor;
const hash = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const make = (current = () => true, digest = hash) => new DesktopGenerationReader(identity, fixture.expectedUserId, current, digest);

describe('Desktop generation raw-envelope assembly', () => {
  it('verifies the shared UTF-8 fixture and preserves escaped lone surrogates after JSON parsing', async () => {
    const reader = make(); reader.describe(identity);
    expect(await reader.append(fixture.fragments[0])).toBeNull();
    const result = await reader.append(fixture.fragments[1]);
    expect(result).toEqual(JSON.parse(fixture.rawEnvelope).result);
    expect(result!.markdown.endsWith('\ud800')).toBe(true);
  });
  it.each(['roomId', 'roomEpoch', 'generationId', 'attempt', 'byteLength', 'digest'])('rejects mismatched or invalid descriptor %s', key => {
    const reader = make();
    const value = key === 'attempt' ? 2 : key === 'byteLength' ? 76_711_889 : key === 'digest' ? 'A'.repeat(64) : 'other';
    expect(() => reader.describe({ ...identity, [key]: value })).toThrow('invalid-response');
  });
  it.each(['offset', 'requestId', 'early-final', 'overflow', 'non-scalar'])('rejects invalid fragment %s', async kind => {
    const reader = make(); reader.describe(identity);
    const fragment = { ...fixture.fragments[0], ...(kind === 'offset' ? { offset: 1 } : kind === 'requestId' ? { requestId: 'other' }
      : kind === 'early-final' ? { final: true } : kind === 'overflow' ? { text: 'x'.repeat(16_385) } : { text: '\ud800' }) };
    await expect(reader.append(fragment)).rejects.toThrow('invalid-response');
  });
  it('rejects duplicate descriptors and digest corruption without returning a partial view', async () => {
    const reader = make(); reader.describe({ ...identity, digest: '0'.repeat(64) });
    expect(() => reader.describe(identity)).toThrow('invalid-response');
    await reader.append(fixture.fragments[0]);
    await expect(reader.append(fixture.fragments[1])).rejects.toThrow('invalid-response');
  });
  it.each(['viewer', 'unknown-field', 'target', 'invalid-json', 'final-proof'])('strictly parses the original envelope after a valid digest: %s', async kind => {
    const body = JSON.parse(fixture.rawEnvelope);
    if (kind === 'viewer') body.desktopRoom.viewerUserId = 99;
    if (kind === 'unknown-field') body.result.secretExtra = 'must-not-project-away';
    if (kind === 'target') body.result.generation.attempt = 2;
    if (kind === 'final-proof') body.result.finalAuthoritative = false;
    const text = kind === 'invalid-json' ? '{' : JSON.stringify(body);
    const bytes = new TextEncoder().encode(text);
    const reader = make(); reader.describe({ ...identity, byteLength: bytes.byteLength, digest: await hash(bytes) });
    await expect(reader.append({ kind: 'generation-fragment', requestId: identity.requestId, offset: 0, text, final: true })).rejects.toThrow('invalid-response');
  });
  it('rechecks ownership after asynchronous hashing', async () => {
    let current = true, resolve!: (value: string) => void;
    const reader = make(() => current, () => new Promise(yes => { resolve = yes; })); reader.describe(identity);
    await reader.append(fixture.fragments[0]); const result = reader.append(fixture.fragments[1]);
    current = false; resolve(identity.digest);
    await expect(result).rejects.toThrow('scope-changed');
  });
});
