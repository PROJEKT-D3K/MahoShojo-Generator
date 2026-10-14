import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/desktop-magic-tea-party.json';
import { jsonUtf8ByteLength } from '../src/wire-size';
import {
  DESKTOP_TEA_LIMITS, TeaSessionDocumentSchema, TeaMessageDocumentSchema,
  TeaReadRequestSchema, TeaWriteRequestSchema, TeaReadResponseSchema, TeaStorageErrorSchema,
} from '../src/desktop-magic-tea-party';

const session = () => structuredClone(fixture.session);
const message = () => structuredClone(fixture.messages[1]);
const write = () => ({ version: 1, request: { action: 'import', operationId: 'import-a', entries: [{ session: session(), messages: fixture.messages }] } });
const placeholder = () => ({ id: 'assistant-a', sessionId: fixture.session.id, role: 'assistant', createdAt: 3, content: '', status: 'streaming' });
const maximumMessage = () => {
  const doc = { id: 'm', sessionId: 's', role: 'assistant', content: '', createdAt: 1, status: 'done' };
  doc.content = 'a'.repeat(DESKTOP_TEA_LIMITS.messageBytes - jsonUtf8ByteLength(doc));
  return doc;
};

describe('Desktop Tea closed local storage wire', () => {
  it('preserves real text fixture and unknown inert extensions', () => {
    expect(TeaSessionDocumentSchema.parse(session())).toEqual(fixture.session);
    expect(TeaMessageDocumentSchema.parse(message())).toEqual(fixture.messages[1]);
    expect(TeaWriteRequestSchema.parse(write())).toEqual(write());
    expect(TeaReadRequestSchema.parse({ version: 1, request: { action: 'receipt', write: write() } }).request.action).toBe('receipt');
  });
  it('does not silently strip unsafe JSON keys before the document gate', () => {
    for (const field of ['__proto__', 'constructor', 'prototype']) {
      const doc = { ...session(), future: JSON.parse(`{"${field}":{"payload":true}}`) };
      expect(TeaSessionDocumentSchema.safeParse(doc).success).toBe(false);
    }
  });
  it('rejects unsupported known media before writes', () => {
    expect(TeaSessionDocumentSchema.safeParse({ ...session(), tachieAssets: [] }).success).toBe(false);
    expect(TeaMessageDocumentSchema.safeParse({ ...message(), tachieId: 'image' }).success).toBe(false);
    expect(TeaSessionDocumentSchema.parse({ ...session(), roles: [{ ...session().roles[0], avatarUrl: 'https://synthetic.invalid/no-fetch' }] }).roles[0].avatarUrl).toBe('https://synthetic.invalid/no-fetch');
  });
  it.each(['\ud800', '\udfff'])('rejects a lone surrogate in value and key: %j', value => {
    expect(TeaMessageDocumentSchema.safeParse({ ...message(), content: value }).success).toBe(false);
    expect(TeaSessionDocumentSchema.safeParse({ ...session(), future: { [value]: true } }).success).toBe(false);
  });
  it('preserves paired scalars, JSON control escapes, and unnormalized user text', () => {
    const content = '🍵\u0001e\u0301';
    expect(TeaMessageDocumentSchema.parse({ ...message(), content }).content).toBe(content);
  });
  it('rejects executable or non-JSON data without invoking accessors', () => {
    let called = false;
    const unsafe = Object.defineProperty({}, 'hidden', { enumerable: true, get: () => { called = true; return 'secret'; } });
    for (const future of [unsafe, Infinity, undefined, new Date(0), () => undefined]) expect(TeaSessionDocumentSchema.safeParse({ ...session(), future }).success).toBe(false);
    expect(called).toBe(false);
  });
  it('closes operations, version, and host-selector fields', () => {
    expect(TeaWriteRequestSchema.safeParse({ ...write(), version: 2 }).success).toBe(false);
    expect(TeaWriteRequestSchema.safeParse({ version: 1, request: { action: 'create', session: session(), path: '/tmp/unrelated' } }).success).toBe(false);
    expect(TeaReadRequestSchema.safeParse({ version: 1, request: { action: 'sql', sql: 'SELECT 1' } }).success).toBe(false);
    expect(TeaReadRequestSchema.safeParse({ version: 1, request: { action: 'receipt', write: { version: 1, request: { action: 'create', session: session() } } } }).success).toBe(false);
  });
  it('admits only a minimal recoverable streaming placeholder', () => {
    const value = { version: 1, request: { action: 'begin-generation', sessionId: fixture.session.id, instance: fixture.instance, expectedRevision: 1, operationId: 'begin-a', session: session(), userMessage: null, assistantMessage: placeholder() } };
    expect(TeaWriteRequestSchema.safeParse(value).success).toBe(true);
    expect(TeaWriteRequestSchema.safeParse({ ...value, request: { ...value.request, assistantMessage: { ...placeholder(), meta: {} } } }).success).toBe(false);
  });
  it('rejects unsafe revision precision and non-progressing query limits', () => {
    const value = { version: 1, request: { action: 'messages', sessionId: fixture.session.id, instance: fixture.instance, expectedRevision: 1, cursor: null, expectedCatalogRevision: null, limit: 1 } };
    expect(TeaReadRequestSchema.safeParse(value).success).toBe(true);
    for (const expectedRevision of [0, Number.MAX_SAFE_INTEGER + 1, 1.5]) expect(TeaReadRequestSchema.safeParse({ ...value, request: { ...value.request, expectedRevision } }).success).toBe(false);
    expect(TeaReadRequestSchema.safeParse({ ...value, request: { ...value.request, limit: 0 } }).success).toBe(false);
  });
  it('accepts a message at the exact serialized byte limit', () => {
    const doc = maximumMessage();
    expect(jsonUtf8ByteLength(doc)).toBe(DESKTOP_TEA_LIMITS.messageBytes);
    expect(TeaMessageDocumentSchema.safeParse(doc).success).toBe(true);
  });
  it('rejects a message one byte above the serialized byte limit', () => {
    const doc = maximumMessage();
    expect(TeaMessageDocumentSchema.safeParse({ ...doc, content: `${doc.content}x` }).success).toBe(false);
  });
  it('fits a maximum-size message in a complete read response page', () => {
    const doc = maximumMessage();
    const page = { version: 1, result: { action: 'messages', catalogRevision: Number.MAX_SAFE_INTEGER, sessionId: 's', instance: fixture.instance, revision: Number.MAX_SAFE_INTEGER, rows: [{ ordinal: Number.MAX_SAFE_INTEGER, message: doc }], nextCursor: { ordinal: Number.MAX_SAFE_INTEGER, id: 'm' } } };
    expect(jsonUtf8ByteLength(page)).toBeLessThan(DESKTOP_TEA_LIMITS.pageBytes);
    expect(TeaReadResponseSchema.safeParse(page).success).toBe(true);
  });
  it('exposes fixed errors with honest commit uncertainty', () => {
    expect(TeaStorageErrorSchema.parse({ code: 'tea-commit-unknown', message: 'Local tea storage did not complete; retain the input or unsaved result', writeEvidence: 'unknown' }).writeEvidence).toBe('unknown');
    expect(TeaStorageErrorSchema.safeParse({ code: 'tea-io', message: '/private/path', writeEvidence: 'not-written' }).success).toBe(false);
  });
});
