import { describe, expect, it, vi } from 'vitest';
import {
  STORY_CANDIDATE_FRAME_BYTES, StoryPendingSnapshotSchema,
  type StoryPendingManifest, type StoryPendingSnapshot, type StoryPendingPartKind,
} from '@mahoshojo/contracts/desktop-arena-story';
import { createBattleStoryByteDigest } from '@mahoshojo/domain/arena-story-commit';
import type { StoryPendingNativePort, StoryPendingExportPort } from '../src/platform/arena-story-pending-native';
import {
  describeStoryPending, readStoryPendingPartText, prepareStoryPendingUpload, publishStoryPending,
  prepareStoryPendingReceiptExpectation, queryStoryPendingReceipt, createStoryPendingSaveAttempt,
  abandonStoryPending, exportStoryPendingOriginal, exportAllStoryPendingOriginals, storyPendingKey,
} from '../src/platform/arena-story-pending-storage';

const token = `${'a'.repeat(32)}-${'b'.repeat(32)}`;
const otherToken = `${'c'.repeat(32)}-${'d'.repeat(32)}`;
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => { const hash = createBattleStoryByteDigest(); hash.update(bytes); return hash.digest(); };
const input = encoder.encode(JSON.stringify({
  version: 1, sessionId: 'session', generationRequestId: 'story_request_1234', action: 'start', chapterIndex: 1,
  chapterContext: { recentWindow: [], workingCombatants: [{ name: '雪' }] },
  seed: { combatants: [{ name: '雪' }], mode: 'daily', storyLength: 'default', language: 'zh-CN', settings: {
    readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false,
    readNarrativeHistory: false, writeNarrativeHistory: false,
  } },
}));
const fixture = (extras: Partial<Record<StoryPendingPartKind, Uint8Array>> = {}) => {
  const bytes = { input, ...extras };
  const manifest: StoryPendingManifest = {
    version: 1, product: 'battle', requestId: 'story_request_1234', actor: { kind: 'anonymous' }, pendingRevision: 1,
    sessionId: 'session', operationId: 'chapter', outputCheckpointId: 'after', initialCheckpointId: 'before', createdAt: 0,
    expectedRevision: 0, expectedLastChapterId: null, lastInputCheckpointId: 'before', inputDigest: digest(bytes.input),
    writeOptions: { writeArenaHistory: false, writeCurrentState: false, writeNarrativeHistory: false },
    modelCompleted: false, roleState: 'not-requested', roleInputDigest: null, commitManifest: null,
    parts: Object.entries(bytes).map(([kind, raw]) => ({ kind: kind as StoryPendingPartKind, byteLength: raw.length, digest: digest(raw) })),
  };
  const snapshot: StoryPendingSnapshot = { manifest, restored: false, abandonRequested: false, createClaim: null, saveAttemptId: null };
  const sources = manifest.parts.map(({ kind }) => ({ kind, chunks: function* () {
    const raw = bytes[kind as keyof typeof bytes]!;
    for (let offset = 0; offset < raw.length; offset += STORY_CANDIDATE_FRAME_BYTES) yield raw.subarray(offset, offset + STORY_CANDIDATE_FRAME_BYTES);
  } }));
  return { bytes, manifest, snapshot, sources };
};
const mockPort = (snapshot: StoryPendingSnapshot | null = null) => ({
  begin: vi.fn(async (manifest: StoryPendingManifest) => ({ token, totalBytes: manifest.parts.reduce((n, part) => n + part.byteLength, 0) })),
  append: vi.fn<StoryPendingNativePort['append']>(async (_token, kind, offset, bytes) => ({ token, kind, receivedBytes: offset + bytes.length })),
  queryUpload: vi.fn<StoryPendingNativePort['queryUpload']>(), seal: vi.fn<StoryPendingNativePort['seal']>(), abortUpload: vi.fn<StoryPendingNativePort['abortUpload']>(), describe: vi.fn(async () => snapshot), read: vi.fn<StoryPendingNativePort['read']>(),
  prepareSave: vi.fn(async () => ({ attemptId: token })), save: vi.fn<StoryPendingNativePort['save']>(), receipt: vi.fn<StoryPendingNativePort['receipt']>(async () => null), abandon: vi.fn<StoryPendingNativePort['abandon']>(),
}) satisfies StoryPendingNativePort;
const uploadPort = (value: ReturnType<typeof fixture>) => {
  const port = mockPort();
  const offsets = value.manifest.parts.map(({ kind }) => ({ kind, receivedBytes: 0 }));
  port.queryUpload.mockImplementation(async () => ({ token, manifest: value.manifest, receivedBytes: structuredClone(offsets) }));
  port.append.mockImplementation(async (_token, kind, offset, bytes) => {
    offsets.find((part) => part.kind === kind)!.receivedBytes = offset + bytes.length;
    return { token, kind, receivedBytes: offset + bytes.length };
  });
  port.seal.mockResolvedValue(value.snapshot);
  return { port, offsets };
};
const frozen = () => {
  const value = fixture({ markdown: encoder.encode('完整正文'), session: encoder.encode('{}'), seed: encoder.encode('{}'),
    chapter: encoder.encode('{}'), checkpoint0: encoder.encode('{}'), checkpoint1: encoder.encode('{}') });
  value.manifest.modelCompleted = true;
  value.manifest.commitManifest = { version: 1, sessionId: 'session', operationId: 'chapter', expectedRevision: 0,
    expectedLastChapterId: null, parts: value.manifest.parts.filter((part) => ['session', 'seed', 'chapter', 'checkpoint0', 'checkpoint1'].includes(part.kind)) as NonNullable<StoryPendingManifest['commitManifest']>['parts'] };
  return value;
};
const readPort = (value: ReturnType<typeof fixture>) => {
  const port = mockPort(value.snapshot);
  port.read.mockImplementation(async (_key, kind, offset, length) => value.bytes[kind as keyof typeof value.bytes]!.slice(offset, offset + length));
  return port;
};

describe('pending originals reader', () => {
  it('reads exact raw UTF-8 across frames without parse/reserialize and verifies every frame snapshot', async () => {
    const raw = encoder.encode(' '.repeat(STORY_CANDIDATE_FRAME_BYTES - 1) + '雪𝌆');
    const value = fixture({ meta: raw }), port = readPort(value);
    expect(await readStoryPendingPartText(port, value.snapshot, 'meta')).toBe(new TextDecoder().decode(raw));
    expect(port.read.mock.calls.map((call) => call.slice(2))).toEqual([[0, STORY_CANDIDATE_FRAME_BYTES], [STORY_CANDIDATE_FRAME_BYTES, raw.length - STORY_CANDIDATE_FRAME_BYTES]]);
    expect(port.describe).toHaveBeenCalledTimes(5);
  });
  it.each(['product', 'requestId', 'pendingRevision', 'inputDigest', 'abandonRequested'] as const)('rejects changed exact %s snapshot before delivering a complete part', async (field) => {
    const value = fixture(), port = readPort(value), changed = structuredClone(value.snapshot);
    if (field === 'abandonRequested') changed.abandonRequested = true;
    else if (field === 'inputDigest') { changed.manifest.inputDigest = `sha256:${'1'.repeat(64)}`; changed.manifest.parts[0]!.digest = changed.manifest.inputDigest; }
    else if (field === 'pendingRevision') changed.manifest.pendingRevision = 2;
    else if (field === 'product') changed.manifest.product = 'arena';
    else changed.manifest.requestId = 'other_request_1234';
    port.describe.mockResolvedValueOnce(value.snapshot).mockResolvedValueOnce(changed);
    await expect(readStoryPendingPartText(port, value.snapshot, 'input')).rejects.toThrow();
  });
  it('rejects wrong part, short, oversized, corrupt and malformed UTF-8 frames', async () => {
    const value = fixture(), port = readPort(value);
    await expect(readStoryPendingPartText(port, value.snapshot, 'markdown')).rejects.toThrow();
    for (const raw of [input.slice(1), new Uint8Array(input.length + 1), new Uint8Array(input.length)]) {
      port.read.mockResolvedValueOnce(raw);
      await expect(readStoryPendingPartText(port, value.snapshot, 'input')).rejects.toThrow();
    }
    const broken = fixture({ markdown: new Uint8Array([255]) });
    await expect(readStoryPendingPartText(readPort(broken), broken.snapshot, 'markdown')).rejects.toThrow();
    const wrong = mockPort({ ...value.snapshot, manifest: { ...value.manifest, product: 'arena' } });
    await expect(describeStoryPending(wrong, 'battle')).rejects.toThrow();
  });
});

describe('pending publisher bounded exact recovery', () => {
  it('retains opaque original bytes and handles a lost begin acknowledgement with one exact begin retry', async () => {
    const raw = encoder.encode('{ "opaque": "\\ud800雪", "duplicate":1,"duplicate":2 }');
    const value = fixture({ meta: raw }), { port } = uploadPort(value);
    port.begin.mockRejectedValueOnce(new Error('lost begin'));
    const prepared = await prepareStoryPendingUpload(value.manifest, value.sources);
    expect(await publishStoryPending(port, prepared, null)).toEqual(value.snapshot);
    expect(port.begin).toHaveBeenCalledTimes(2);
    expect(port.append.mock.calls[1]![3]).toEqual(raw);
    expect(port.abortUpload).not.toHaveBeenCalled();
  });
  it('uses an exact durable query to recover a lost final-carrier acknowledgement, without replaying bytes', async () => {
    const value = fixture(), { port, offsets } = uploadPort(value);
    port.append.mockImplementationOnce(async () => { offsets[0]!.receivedBytes = input.length; throw new Error('ack lost'); });
    expect(await publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), null)).toEqual(value.snapshot);
    expect(port.append).toHaveBeenCalledTimes(1); expect(port.queryUpload).toHaveBeenCalledTimes(2);
  });
  it('does not rewind an uncertain buffered prefix from durable zero', async () => {
    const value = fixture({ meta: new Uint8Array(STORY_CANDIDATE_FRAME_BYTES + 1) }), { port } = uploadPort(value);
    port.append.mockImplementation(async (_token, kind, offset, bytes) => {
      if (kind === 'meta') throw new Error('buffered ACK lost');
      return { token, kind, receivedBytes: offset + bytes.length };
    });
    await expect(publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), null)).rejects.toMatchObject({ phase: 'append' });
    expect(port.append).toHaveBeenCalledTimes(2); expect(port.seal).not.toHaveBeenCalled(); expect(port.abortUpload).not.toHaveBeenCalled();
  });
  it('reconciles lost seal acknowledgement from the exact active snapshot', async () => {
    const value = fixture(), { port } = uploadPort(value);
    port.seal.mockImplementationOnce(async () => { port.describe.mockResolvedValue(value.snapshot); throw new Error('lost seal'); });
    expect(await publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), null)).toEqual(value.snapshot);
    expect(port.seal).toHaveBeenCalledTimes(1);
  });
  it('retries seal only once against a fully uploaded exact manifest', async () => {
    const value = fixture(), { port } = uploadPort(value);
    port.seal.mockRejectedValueOnce(new Error('not sealed'));
    expect(await publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), null)).toEqual(value.snapshot);
    expect(port.seal).toHaveBeenCalledTimes(2);
  });
  it.each(['token', 'manifest', 'offset'] as const)('rejects malformed upload query %s evidence without seal', async (field) => {
    const value = fixture(), { port } = uploadPort(value);
    port.queryUpload.mockResolvedValue({ token: field === 'token' ? otherToken : token,
      manifest: field === 'manifest' ? { ...value.manifest, requestId: 'other_request_1234' } : value.manifest,
      receivedBytes: [{ kind: 'input', receivedBytes: field === 'offset' ? input.length + 1 : 0 }] });
    await expect(publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), null)).rejects.toThrow();
    expect(port.append).not.toHaveBeenCalled(); expect(port.seal).not.toHaveBeenCalled();
  });
  it('preserves old parts and refuses restored, saving or abandoning replacement baselines', async () => {
    const old = fixture(), value = fixture({ markdown: encoder.encode('完成正文') });
    value.manifest.pendingRevision = 2; value.manifest.modelCompleted = true;
    for (const patch of [{ restored: true }, { abandonRequested: true }, { saveAttemptId: token }]) {
      const previous = { ...old.snapshot, ...patch }, port = mockPort(previous);
      await expect(publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), previous)).rejects.toThrow();
      expect(port.begin).not.toHaveBeenCalled();
    }
    const changed = fixture({ input: encoder.encode('changed') }); changed.manifest.pendingRevision = 2;
    const port = mockPort(old.snapshot);
    await expect(publishStoryPending(port, await prepareStoryPendingUpload(changed.manifest, changed.sources), old.snapshot)).rejects.toThrow();
    expect(port.begin).not.toHaveBeenCalled();
  });
  it.each(['battle', 'arena'] as const)('publishes exact %s actors without swapping identities', async (product) => {
    for (const actor of [{ kind: 'anonymous' } as const, { kind: 'account', expectedUserId: 42 } as const]) {
      const value = fixture(); value.manifest.product = product; value.manifest.actor = actor;
      const { port } = uploadPort(value);
      expect(await publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), null)).toEqual(value.snapshot);
    }
  });
  it('requires an old-roles choice and frozen commit in the same seal while allowing old snapshots to be read', async () => {
    const value = fixture(); value.manifest.modelCompleted = true; value.manifest.roleState = 'old-roles'; value.manifest.roleInputDigest = value.manifest.inputDigest;
    expect(StoryPendingSnapshotSchema.parse(value.snapshot)).toEqual(value.snapshot);
    const { port } = uploadPort(value);
    await expect(publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), null)).rejects.toThrow('冻结提交');
    expect(port.begin).not.toHaveBeenCalled();
  });
  it('retains an existing raw part byte-for-byte in a later revision and rejects replacement of that part', async () => {
    const old = fixture({ markdown: encoder.encode('原文') }), value = fixture({ markdown: encoder.encode('原文'), telemetry: encoder.encode('{}') });
    old.manifest.modelCompleted = true; value.manifest.modelCompleted = true; value.manifest.pendingRevision = 2;
    const { port } = uploadPort(value); port.describe.mockResolvedValue(old.snapshot);
    expect(await publishStoryPending(port, await prepareStoryPendingUpload(value.manifest, value.sources), old.snapshot)).toEqual(value.snapshot);
    const changed = fixture({ markdown: encoder.encode('变更') }); changed.manifest.modelCompleted = true; changed.manifest.pendingRevision = 2;
    const bad = mockPort(old.snapshot);
    await expect(publishStoryPending(bad, await prepareStoryPendingUpload(changed.manifest, changed.sources), old.snapshot)).rejects.toThrow();
    expect(bad.begin).not.toHaveBeenCalled();
  });
  it('rejects bad preflight and mutation after preflight without sealing', async () => {
    const value = fixture({ markdown: encoder.encode('old') }), { port } = uploadPort(value);
    await expect(prepareStoryPendingUpload(value.manifest, value.sources.slice(1))).rejects.toThrow();
    const prepared = await prepareStoryPendingUpload(value.manifest, value.sources);
    value.bytes.markdown![0] = 110;
    await expect(publishStoryPending(port, prepared, null)).rejects.toThrow(); expect(port.seal).not.toHaveBeenCalled();
  });
});

describe('pending single-attempt save and exact receipts', () => {
  it.each(['sessionId', 'operationId', 'chapterId', 'chapterIndex', 'chapterCount', 'revision', 'wireDigest', 'checkpointIds'] as const)('rejects wrong receipt %s', async (field) => {
    const value = frozen(), expected = await prepareStoryPendingReceiptExpectation(value.snapshot, 1), port = readPort(value);
    const bad = { ...expected, [field]: field === 'checkpointIds' ? ['wrong'] : field === 'wireDigest' ? `sha256:${'0'.repeat(64)}`
      : ['chapterIndex', 'chapterCount', 'revision'].includes(field) ? 2 : 'wrong' };
    port.receipt.mockResolvedValue(bad as never);
    await expect(queryStoryPendingReceipt(port, expected)).rejects.toThrow(); expect(port.prepareSave).not.toHaveBeenCalled();
  });
  it('prepares and saves exactly once, sharing the action Promise', async () => {
    const value = frozen(), port = readPort(value), expected = await prepareStoryPendingReceiptExpectation(value.snapshot, 1);
    port.prepareSave.mockImplementation(async () => { port.describe.mockResolvedValue({ ...value.snapshot, saveAttemptId: token }); return { attemptId: token }; });
    port.save.mockResolvedValue(expected);
    const action = await createStoryPendingSaveAttempt(port, value.snapshot, 1);
    const first = action.saveOnce(); expect(action.saveOnce()).toBe(first); expect(await first).toEqual(expected);
    expect(await action.saveOnce()).toEqual(expected); expect(port.prepareSave).toHaveBeenCalledTimes(1); expect(port.save).toHaveBeenCalledTimes(1);
  });
  it.each(['prepare', 'save'] as const)('unknown %s plus absent receipt never prepares or saves a second time', async (phase) => {
    const value = frozen(), port = readPort(value);
    if (phase === 'prepare') port.prepareSave.mockRejectedValue(new Error('lost prepare'));
    else {
      port.prepareSave.mockImplementation(async () => { port.describe.mockResolvedValue({ ...value.snapshot, saveAttemptId: token }); return { attemptId: token }; });
      port.save.mockRejectedValue(new Error('lost save'));
    }
    const action = await createStoryPendingSaveAttempt(port, value.snapshot, 1), promise = action.saveOnce();
    await expect(promise).rejects.toMatchObject({ evidence: 'unknown' }); expect(action.saveOnce()).toBe(promise);
    expect(await action.queryReceipt()).toBeNull(); expect(port.prepareSave).toHaveBeenCalledTimes(1);
    expect(port.save).toHaveBeenCalledTimes(phase === 'save' ? 1 : 0);
  });
  it.each([{ restored: true }, { abandonRequested: true }, { saveAttemptId: token }])('restored/abandoning/attempted only queries receipts %#', async (patch) => {
    const value = frozen(), snapshot = { ...value.snapshot, ...patch }, port = readPort({ ...value, snapshot });
    const action = await createStoryPendingSaveAttempt(port, snapshot, 1);
    await expect(action.saveOnce()).rejects.toMatchObject({ evidence: 'unknown' });
    expect(port.prepareSave).not.toHaveBeenCalled(); expect(port.save).not.toHaveBeenCalled(); expect(port.read).not.toHaveBeenCalled();
  });
  it('resolves a lost save acknowledgement only from an exact receipt', async () => {
    const value = frozen(), port = readPort(value), expected = await prepareStoryPendingReceiptExpectation(value.snapshot, 1);
    port.prepareSave.mockImplementation(async () => { port.describe.mockResolvedValue({ ...value.snapshot, saveAttemptId: token }); return { attemptId: token }; });
    port.save.mockImplementation(async () => { port.receipt.mockResolvedValue(expected as never); throw new Error('ACK lost'); });
    const action = await createStoryPendingSaveAttempt(port, value.snapshot, 1);
    expect(await action.saveOnce()).toEqual(expected); expect(port.save).toHaveBeenCalledTimes(1);
  });
  it('a malformed save receipt or a later failing receipt query never grants another save', async () => {
    const value = frozen(), port = readPort(value);
    port.prepareSave.mockImplementation(async () => { port.describe.mockResolvedValue({ ...value.snapshot, saveAttemptId: token }); return { attemptId: token }; });
    port.save.mockImplementation(async () => { port.receipt.mockRejectedValue(new Error('receipt offline')); return { success: true }; });
    const action = await createStoryPendingSaveAttempt(port, value.snapshot, 1), promise = action.saveOnce();
    await expect(promise).rejects.toMatchObject({ evidence: 'unknown' }); expect(action.saveOnce()).toBe(promise);
    expect(port.prepareSave).toHaveBeenCalledTimes(1); expect(port.save).toHaveBeenCalledTimes(1);
  });
  it('labels a proven rollback only after exact Native attempt-clear readback, without retrying it', async () => {
    const value = frozen(), port = readPort(value);
    port.prepareSave.mockImplementation(async () => { port.describe.mockResolvedValue({ ...value.snapshot, saveAttemptId: token }); return { attemptId: token }; });
    port.save.mockImplementation(async () => { port.describe.mockResolvedValue(value.snapshot); throw { code: 'story-conflict', message: 'rollback', writeEvidence: 'not-written' }; });
    const action = await createStoryPendingSaveAttempt(port, value.snapshot, 1), promise = action.saveOnce();
    await expect(promise).rejects.toMatchObject({ evidence: 'not-written' }); expect(action.saveOnce()).toBe(promise);
    expect(port.prepareSave).toHaveBeenCalledTimes(1); expect(port.save).toHaveBeenCalledTimes(1);
  });
  it('wrong claimed chapter index fails before prepare', async () => {
    const value = frozen(), port = readPort(value), action = await createStoryPendingSaveAttempt(port, value.snapshot, 2);
    await expect(action.saveOnce()).rejects.toThrow(); expect(port.prepareSave).not.toHaveBeenCalled();
  });
});

describe('explicit local abandonment and original export', () => {
  it('checks exact exit identity and reports partial cleanup without automatically retrying', async () => {
    const { manifest } = fixture(), port = mockPort(), request = { key: storyPendingKey(manifest), inputDigest: manifest.inputDigest, actor: manifest.actor };
    const partial = { ...request, state: 'cleanup-pending', candidate: 'retained', flight: 'released', secret: 'unresolved' };
    port.abandon.mockResolvedValue(partial);
    expect(await abandonStoryPending(port, request)).toEqual(partial); expect(port.abandon).toHaveBeenCalledTimes(1);
    port.abandon.mockResolvedValue({ ...partial, actor: { kind: 'account', expectedUserId: 5 } });
    await expect(abandonStoryPending(port, request)).rejects.toThrow();
  });
  const exportPort = (length: number, hash: string) => ({
    begin: vi.fn(async () => ({ token, expectedByteLength: length, digest: hash })),
    advance: vi.fn(async (_token: string, offset: number) => ({ token, receivedBytes: Math.min(length, offset + 64 * 1024) })),
    end: vi.fn(async () => ({ token, absolutePath: '/exports/pending-original', byteLength: length, digest: hash })), abort: vi.fn(async () => {}),
  }) satisfies StoryPendingExportPort;
  it('copies only through Native frame advances and requires a digest/length/token matching final receipt', async () => {
    const { manifest } = fixture({ markdown: new Uint8Array(128 * 1024 + 1) }), part = manifest.parts[1]!, sink = exportPort(part.byteLength, part.digest);
    const source = { scope: 'pending-part' as const, key: storyPendingKey(manifest), inputDigest: manifest.inputDigest, ...part };
    const outcome = await exportStoryPendingOriginal(sink, source);
    expect(outcome.digest).toBe(part.digest); expect(sink.advance.mock.calls.map((call) => call[1])).toEqual([0, 64 * 1024, 128 * 1024]);
    sink.end.mockResolvedValueOnce({ ...outcome, token: otherToken });
    await expect(exportStoryPendingOriginal(sink, source)).rejects.toThrow();
    expect(sink.abort).toHaveBeenCalledTimes(2);
  });
  it('cancels and rejects stalled/oversized frames without publishing', async () => {
    const { manifest } = fixture(), part = manifest.parts[0]!, source = { scope: 'pending-part' as const, key: storyPendingKey(manifest), inputDigest: manifest.inputDigest, ...part };
    for (const receivedBytes of [0, part.byteLength + 1]) {
      const sink = exportPort(part.byteLength, part.digest); sink.advance.mockResolvedValue({ token, receivedBytes });
      await expect(exportStoryPendingOriginal(sink, source)).rejects.toThrow(); expect(sink.end).not.toHaveBeenCalled();
    }
    const sink = exportPort(part.byteLength, part.digest), controller = new AbortController();
    await expect(exportStoryPendingOriginal(sink, source, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
    expect(sink.end).not.toHaveBeenCalled(); expect(sink.abort).toHaveBeenCalledTimes(1);
  });
  it('exports every canonical part and then the small Native manifest; partial receipts never mean all succeeded', async () => {
    const value = fixture({ markdown: encoder.encode('完成章') }), port = readPort(value);
    let length = 0, hash = '';
    const sink: StoryPendingExportPort = {
      begin: vi.fn(async (source) => { length = source.scope === 'pending-part' ? source.byteLength : 30; hash = source.scope === 'pending-part' ? source.digest : digest(encoder.encode('manifest')); return { token, expectedByteLength: length, digest: hash }; }),
      advance: vi.fn(async () => ({ token, receivedBytes: length })),
      end: vi.fn(async () => ({ token, absolutePath: '/exports/original', byteLength: length, digest: hash })), abort: vi.fn(),
    };
    const onExported = vi.fn();
    expect(await exportAllStoryPendingOriginals(port, sink, value.snapshot, { onExported })).toHaveLength(3);
    expect(onExported.mock.calls.map((call) => call[0])).toEqual(['input', 'markdown', 'manifest']);
    expect(StoryPendingSnapshotSchema.parse(value.snapshot).manifest.parts).toHaveLength(2);
    expect(port.abandon).not.toHaveBeenCalled();
    vi.mocked(sink.end).mockRejectedValueOnce(new Error('disk full'));
    await expect(exportAllStoryPendingOriginals(port, sink, value.snapshot, { onExported })).rejects.toThrow('disk full');
    expect(onExported).toHaveBeenCalledTimes(3);
    expect(port.abandon).not.toHaveBeenCalled();
  });
});
