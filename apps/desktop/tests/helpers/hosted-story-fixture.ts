import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import {
  STORY_CANDIDATE_FRAME_BYTES, StoryPendingManifestSchema, StoryPendingSnapshotSchema, StorySourceSchema,
  StoryPendingInputSchema, StoryPendingHeaderSchema, StoryPendingMetaSchema, StoryPendingTelemetrySchema,
  StoryPendingRoleResponseSchema, StoryPendingAbandonRequestSchema, StoryPendingExportSourceSchema,
  type StoryPendingManifest, type StoryPendingSnapshot, type StoryPendingPartKind, type StoryPendingKey,
  type StoryPendingExportSource, type StoryPendingFundingSnapshot,
} from '@mahoshojo/contracts/desktop-arena-story';
import {
  DesktopArenaHostedStoryCreateRequestSchema, DesktopArenaHostedStoryReconcileRequestSchema,
  type DesktopArenaHostedStoryCreateRequest,
} from '@mahoshojo/contracts/desktop-arena-story-transport';
import {
  DesktopArenaHostedStreamRequestSchema, DesktopArenaHostedControlRequestSchema,
  type DesktopArenaHostedActor, type DesktopArenaHostedHeaderMeta,
} from '@mahoshojo/contracts/desktop-arena-hosted';
import { createIpcStoryPendingPort, createIpcStoryPendingExportPort, STORY_PENDING_IPC } from '../../src/platform/arena-story-pending-native';
import { STORY_KIND_HEADER, STORY_OFFSET_HEADER, STORY_TOKEN_HEADER } from '../../src/platform/arena-story-native';
import { storyWireDigest } from '../../src/platform/arena-story-storage';
import type { ArenaHostedChannel } from '../../src/platform/arena-hosted-bridge';
import type { GenerationDraftStorage } from '../../src/features/generation/session';
import { ARENA_HOSTED_RECOVERY_KEYS } from '../../src/features/arena/hosted-recovery';
import { StoryFixturePort, storyFixtureInvoke, storyDraft } from './story-fixture';
import { captureDesktopStorySeed, type StorySessionSnapshot } from '../../src/features/arena/story-snapshot';
import type { HostedStoryChapterInput, HostedStoryExecutionTarget } from '../../src/features/arena/hosted-story-session';

const encoder = new TextEncoder();
export const hostedDigest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const opaqueToken = (id: number) => `${id.toString(16).padStart(32, 'a')}-${id.toString(16).padStart(32, 'b')}`;
const copy = <T,>(value: T): T => structuredClone(value);
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export type HostedStoryFixtureProduct = 'battle' | 'arena';
export type HostedStoryFixtureRoleMode = 'accepted' | 'zero' | 'network' | 'malformed' | 'http';
export interface HostedStoryPeer {
  requestId: string;
  response(): void;
  event(id: string, event: string, data: unknown): void;
  end(): void;
}
type Sealed = { snapshot: StoryPendingSnapshot; bytes: Map<StoryPendingPartKind, Uint8Array> };
type Upload = { token: string; manifest: StoryPendingManifest; parts: Map<StoryPendingPartKind, Uint8Array[]> };

/** Synthetic Native peer, not a mock of publish/reconcile/save. The default TS IPC binders,
 * C0 parser, digest checks, upload/seal orchestration and atomic record encoder all run.
 * Rust/SQLite/network are intentionally absent and are covered by their own suites. */
export class HostedStoryFixture {
  readonly records = new StoryFixturePort();
  readonly recordInvoke = storyFixtureInvoke(this.records);
  readonly slots = new Map<HostedStoryFixtureProduct, Sealed>();
  readonly pointers = new Map<string, string>();
  readonly trace: string[] = [];
  readonly sealed: Sealed[] = [];
  readonly streams: Record<string, unknown>[] = [];
  readonly controls: Record<string, unknown>[] = [];
  readonly exports: { source: StoryPendingExportSource; bytes: Uint8Array }[] = [];
  readonly attempts = new Set<string>();
  readonly generations = new Map<string, string>();
  readonly storage: GenerationDraftStorage = {
    getItem: key => this.pointers.get(key) ?? null,
    setItem: (key, value) => { if (this.failPointerWrite) throw new Error('pointer disk full'); this.trace.push('pointer:write'); this.pointers.set(key, value); },
    removeItem: key => { this.trace.push('pointer:remove'); this.pointers.delete(key); },
  };
  roleMode: HostedStoryFixtureRoleMode = 'accepted';
  failPointerWrite = false;
  omitStreamEnd = false;
  malformedAfterDone = false;
  failSeal: ((manifest: StoryPendingManifest) => boolean) | null = null;
  failPrepareSave = false;
  loseSaveReply = false;
  failExport = false;
  partialAbandon = false;
  beforeModelSettles?: () => Promise<void>;
  beforeRoleSettles?: () => Promise<void>;
  beforeRoleEvents?: () => Promise<void>;
  modelStep?: (peer: HostedStoryPeer) => Promise<void> | void;
  readonly telemetry = { version: 1, aiModel: 'actual-fixture-model', usage: {
    promptTokens: null, completionTokens: 7, reasoningTokens: null, totalTokens: null,
    cachedTokens: 0, completionTokensIncludesReasoning: false,
  } };
  readonly markdown = '# 合成故事\n\n甲与乙保留原设定继续前行。雪𝌆\n';
  readonly reasoning = '完整推理原文\n';
  private upload: Upload | null = null;
  private exportJob: { token: string; source: StoryPendingExportSource; bytes: Uint8Array; offset: number } | null = null;
  private serial = 0;

  readonly invoke = vi.fn(async (command: string, raw?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }): Promise<unknown> => {
    const args = raw as Record<string, unknown>, headers = options?.headers ?? {};
    this.trace.push(command);
    switch (command) {
      case STORY_PENDING_IPC.begin: {
        const manifest = StoryPendingManifestSchema.parse(args.manifest);
        if (!this.upload || JSON.stringify(this.upload.manifest) !== JSON.stringify(manifest)) {
          this.upload = { token: opaqueToken(++this.serial), manifest: copy(manifest), parts: new Map() };
        }
        return { token: this.upload.token, totalBytes: manifest.parts.reduce((sum, part) => sum + part.byteLength, 0) };
      }
      case STORY_PENDING_IPC.append: {
        const upload = this.exactUpload(headers[STORY_TOKEN_HEADER]!);
        const kind = headers[STORY_KIND_HEADER] as StoryPendingPartKind, offset = Number(headers[STORY_OFFSET_HEADER]);
        const chunks = upload.parts.get(kind) ?? [], received = chunks.reduce((sum, bytes) => sum + bytes.length, 0);
        if (received !== offset) throw new Error('pending offset mismatch');
        chunks.push(Uint8Array.from(raw as Uint8Array)); upload.parts.set(kind, chunks);
        return { token: upload.token, kind, receivedBytes: received + (raw as Uint8Array).length };
      }
      case STORY_PENDING_IPC.queryUpload: {
        const upload = this.exactUpload(String(args.token));
        return { token: upload.token, manifest: copy(upload.manifest), receivedBytes: upload.manifest.parts.map(({ kind }) => ({ kind,
          receivedBytes: (upload.parts.get(kind) ?? []).reduce((sum, bytes) => sum + bytes.length, 0) })) };
      }
      case STORY_PENDING_IPC.seal: {
        const upload = this.exactUpload(String(args.token));
        if (this.failSeal?.(upload.manifest)) throw new Error('synthetic seal disk failure');
        const bytes = new Map<StoryPendingPartKind, Uint8Array>();
        for (const part of upload.manifest.parts) {
          const value = Uint8Array.from(Buffer.concat(upload.parts.get(part.kind) ?? []));
          if (value.length !== part.byteLength || hostedDigest(value) !== part.digest) throw new Error('pending digest mismatch');
          const validators = { input: StoryPendingInputSchema, header: StoryPendingHeaderSchema, meta: StoryPendingMetaSchema,
            telemetry: StoryPendingTelemetrySchema, roleResponse: StoryPendingRoleResponseSchema };
          if (part.kind in validators) validators[part.kind as keyof typeof validators].parse(JSON.parse(text(value)));
          bytes.set(part.kind, value);
        }
        if (upload.manifest.commitManifest && JSON.parse(text(bytes.get('chapter')!)).createdAt !== upload.manifest.createdAt) {
          throw new Error('Native pending chapter timestamp differs from original manifest');
        }
        const previous = this.slots.get(upload.manifest.product)?.snapshot;
        const snapshot = StoryPendingSnapshotSchema.parse({ manifest: upload.manifest, createClaim: previous?.createClaim ?? null,
          restored: false, abandonRequested: false, saveAttemptId: null });
        const sealed = { snapshot: copy(snapshot), bytes };
        this.slots.set(snapshot.manifest.product, sealed); this.sealed.push(copy(sealed));
        this.trace.push(`sealed:${snapshot.manifest.modelCompleted ? snapshot.manifest.commitManifest ? 'commit' : snapshot.manifest.roleState === 'accepted' ? 'accepted' : 'completed' : 'input'}`);
        return copy(snapshot);
      }
      case STORY_PENDING_IPC.abortUpload: return;
      case STORY_PENDING_IPC.describe: return copy(this.slots.get(args.product as HostedStoryFixtureProduct)?.snapshot ?? null);
      case STORY_PENDING_IPC.read: {
        const sealed = this.exact(args.key as StoryPendingKey), bytes = sealed.bytes.get(args.kind as StoryPendingPartKind);
        if (!bytes) throw new Error('missing original');
        return Uint8Array.from(bytes.slice(Number(args.offset), Number(args.offset) + Number(args.length))).buffer;
      }
      case STORY_PENDING_IPC.prepareSave: {
        if (this.failPrepareSave) throw new Error('lost preparation reply');
        const sealed = this.exact(args.key as StoryPendingKey), manifest = sealed.snapshot.manifest.commitManifest;
        if (!manifest || sealed.snapshot.saveAttemptId || sealed.snapshot.restored || sealed.snapshot.abandonRequested
          || await storyWireDigest(manifest) !== args.wireDigest) throw new Error('invalid save authority');
        const attemptId = opaqueToken(++this.serial); sealed.snapshot.saveAttemptId = attemptId; this.attempts.add(attemptId);
        return { attemptId };
      }
      case STORY_PENDING_IPC.save: {
        const sealed = this.exact(args.key as StoryPendingKey), attemptId = String(args.attemptId), manifest = sealed.snapshot.manifest.commitManifest!;
        if (!this.attempts.delete(attemptId) || sealed.snapshot.saveAttemptId !== attemptId || await storyWireDigest(manifest) !== args.wireDigest) throw new Error('single-use attempt consumed');
        const begin = await this.records.begin(manifest);
        for (const part of manifest.parts) {
          const bytes = sealed.bytes.get(part.kind)!;
          for (let offset = 0; offset < bytes.length; offset += STORY_CANDIDATE_FRAME_BYTES) await this.records.append(begin.token, part.kind, offset, bytes.slice(offset, offset + STORY_CANDIDATE_FRAME_BYTES));
        }
        const receipt = await this.records.end(begin.token);
        this.slots.delete(sealed.snapshot.manifest.product);
        if (this.loseSaveReply) throw new Error('lost committed save reply');
        return receipt;
      }
      case STORY_PENDING_IPC.abandon: {
        const request = StoryPendingAbandonRequestSchema.parse(args.request), sealed = this.exact(request.key);
        if (sealed.snapshot.manifest.inputDigest !== request.inputDigest || JSON.stringify(sealed.snapshot.manifest.actor) !== JSON.stringify(request.actor)) throw new Error('abandon exact identity mismatch');
        sealed.snapshot.abandonRequested = true;
        if (this.partialAbandon) return { ...request, state: 'cleanup-pending', candidate: 'retained', flight: 'released', secret: 'unresolved' };
        this.slots.delete(request.key.product);
        return { ...request, state: 'abandoned', candidate: 'removed', flight: 'released', secret: 'cleared' };
      }
      case STORY_PENDING_IPC.exportBegin: {
        const source = StoryPendingExportSourceSchema.parse(args.source), sealed = this.exact(source.key);
        if (source.inputDigest !== sealed.snapshot.manifest.inputDigest) throw new Error('foreign export input');
        const bytes = source.scope === 'pending-manifest' ? encoder.encode(JSON.stringify(sealed.snapshot.manifest)) : sealed.bytes.get(source.kind)!;
        if (source.scope === 'pending-part' && (bytes.length !== source.byteLength || hostedDigest(bytes) !== source.digest)) throw new Error('foreign export original');
        this.exportJob = { token: opaqueToken(++this.serial), source, bytes: Uint8Array.from(bytes), offset: 0 };
        return { token: this.exportJob.token, expectedByteLength: bytes.length, digest: hostedDigest(bytes) };
      }
      case STORY_PENDING_IPC.exportAdvance: {
        const job = this.exactExport(String(args.token)); if (job.offset !== args.offset) throw new Error('export offset mismatch');
        job.offset = Math.min(job.bytes.length, job.offset + STORY_CANDIDATE_FRAME_BYTES);
        return { token: job.token, receivedBytes: job.offset };
      }
      case STORY_PENDING_IPC.exportEnd: {
        const job = this.exactExport(String(args.token)); if (this.failExport) throw new Error('export disk full');
        if (job.offset !== job.bytes.length) throw new Error('incomplete export');
        this.exports.push({ source: copy(job.source), bytes: Uint8Array.from(job.bytes) });
        return { token: job.token, absolutePath: `/fixture/exports/original-${this.exports.length}`, byteLength: job.bytes.length, digest: hostedDigest(job.bytes) };
      }
      case STORY_PENDING_IPC.exportAbort: return;
      case 'arena_hosted_stream': return this.stream(args);
      case 'arena_hosted_control': {
        const request = DesktopArenaHostedControlRequestSchema.parse(args.request); this.controls.push(request);
        return { status: 200, body: { generationId: this.generations.get(request.requestId), generationRequestId: request.requestId,
          status: request.operation === 'stop' ? 'cancelled' : 'completed' }, recoveryCredentialState: 'stored' };
      }
      case 'arena_hosted_detach': return;
      default: return this.recordInvoke.invoke(command, raw, options);
    }
  });
  readonly port = createIpcStoryPendingPort(this.invoke);
  readonly sink = createIpcStoryPendingExportPort(this.invoke);
  private exact(key: StoryPendingKey): Sealed {
    const sealed = this.slots.get(key.product);
    if (!sealed || sealed.snapshot.manifest.requestId !== key.requestId || sealed.snapshot.manifest.pendingRevision !== key.pendingRevision) throw new Error('pending identity changed');
    return sealed;
  }
  private exactUpload(token: string) { if (!this.upload || this.upload.token !== token) throw new Error('upload identity changed'); return this.upload; }
  private exactExport(token: string) { if (!this.exportJob || this.exportJob.token !== token) throw new Error('export identity changed'); return this.exportJob; }
  private async stream(args: Record<string, unknown>) {
    const raw = args.request as Record<string, unknown>;
    const request = raw.operation === 'create-story-stream' ? DesktopArenaHostedStoryCreateRequestSchema.parse(raw)
      : raw.operation === 'reconcile-story' ? DesktopArenaHostedStoryReconcileRequestSchema.parse(raw) : DesktopArenaHostedStreamRequestSchema.parse(raw);
    this.streams.push(copy(request));
    if (request.operation === 'create-story-stream') this.claim(request);
    const generationId = this.generations.get(request.requestId)!;
    const channel = args.onEvent as ArenaHostedChannel; let sequence = 0;
    const send = (event: Record<string, unknown>) => channel.onmessage({ requestId: request.requestId, sequence: sequence++, ...event });
    if (request.operation === 'reconcile-story') {
      const sealed = this.exact(request), input = JSON.parse(text(sealed.bytes.get('input')!));
      if (!sealed.snapshot.manifest.modelCompleted || request.generationId !== generationId) throw new Error('role requested before durable completion');
      await this.beforeRoleEvents?.();
      if (this.roleMode === 'network') throw new Error('synthetic role network failure');
      const body = this.roleMode === 'malformed' ? { success: true } : this.roleMode === 'http'
        ? { version: 'arena-reconciliation-v1', generationId, code: 'ARENA_RECONCILIATION_MANIFEST_UNAVAILABLE', error: '原清单不可用' }
        : { version: 'arena-reconciliation-v1', generationId, success: true, warnings: [], updatedCombatants: this.roleMode === 'zero' ? []
          : input.chapterContext.workingCombatants.map((value: { data: Record<string, unknown> }, combatantIndex: number) => ({ combatantIndex,
            data: { ...value.data, content: '原 generation 更新设定', signature: 'server-signed-fixture' }, isNative: true })) };
      send({ kind: 'json-response', status: this.roleMode === 'http' ? 409 : 200, generationId, generationRequestId: request.requestId, recoveryCredentialState: 'stored' });
      send({ kind: 'json-fragment', text: JSON.stringify(body), final: true }); send({ kind: 'json-end' });
      await this.beforeRoleSettles?.(); this.trace.push('role:invoke-settled'); return;
    }
    const input = JSON.parse(text(this.slots.get(request.product)!.bytes.get('input')!));
    const headerMeta: DesktopArenaHostedHeaderMeta = { reportFormat: 'markdown', mode: input.seed.mode, language: input.seed.language,
      outputContract: 'stream-markdown', reporterInfo: { name: '合成记者', publication: '合成速报' } };
    const peer: HostedStoryPeer = { requestId: request.requestId,
      response: () => send({ kind: 'response', status: 200, generationId, generationRequestId: request.requestId, metadataState: 'available', recoveryCredentialState: 'stored', headerMeta }),
      event: (id, event, data) => send({ kind: 'sse-fragment', text: `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`, final: true }),
      end: () => send({ kind: 'stream-end' }),
    };
    if (this.modelStep) await this.modelStep(peer);
    else {
      peer.response(); peer.event('1-0', 'markdown', { chunk: this.markdown }); peer.event('2-0', 'reasoning', { chunk: this.reasoning });
      peer.event('3-0', 'telemetry', this.telemetry); peer.event('4-0', 'done', { ok: true, status: 'completed' });
      if (this.malformedAfterDone) {
        this.trace.push('model:c0-completed');
        await this.beforeModelSettles?.();
        send({ kind: 'invalid-after-terminal' }); peer.end(); this.trace.push('model:invoke-settled'); return;
      }
      if (!this.omitStreamEnd) peer.end();
      this.trace.push('model:c0-completed');
    }
    await this.beforeModelSettles?.(); this.trace.push('model:invoke-settled');
  }
  private claim(request: DesktopArenaHostedStoryCreateRequest) {
    const sealed = this.exact(request), pointer = JSON.parse(this.pointers.get(ARENA_HOSTED_RECOVERY_KEYS[request.product]) ?? 'null');
    if (!pointer || pointer.requestId !== request.requestId || pointer.inputDigest !== request.inputDigest || pointer.bodyHash !== request.clientBodyHash
      || sealed.snapshot.createClaim || sealed.snapshot.restored) throw new Error('create preceded durable input/pointer or repeated an existing claim');
    const generationId = `arena_${(this.generations.size + 1).toString(16).padStart(64, '0')}`;
    this.generations.set(request.requestId, generationId);
    const funding: StoryPendingFundingSnapshot = request.presetConfig ? { mode: 'preset', ...request.presetConfig }
      : { mode: 'system', providerId: 'system', modelId: request.systemConfig?.modelId ?? 'default', ...request.systemConfig };
    sealed.snapshot.createClaim = { version: 1, attemptId: opaqueToken(++this.serial), storyProtocolVersion: 'arena-story-v1',
      inputDigest: request.inputDigest, clientBodyHash: request.clientBodyHash, funding, observedGeneration: { generationId, serverPayloadHash: null } };
    this.trace.push('native:create-claim');
  }
  commands(command: string) { return this.invoke.mock.calls.filter(([name]) => name === command); }
  part(product: HostedStoryFixtureProduct, kind: StoryPendingPartKind) { return text(this.slots.get(product)!.bytes.get(kind)!); }
  target(actor: DesktopArenaHostedActor = { kind: 'anonymous' }, funding: 'system' | 'preset' = 'system'): HostedStoryExecutionTarget {
    return { mode: 'hosted', invoke: this.invoke, actor, modelId: 'deepseek-chat', ...(funding === 'system'
      ? { systemConfig: { modelId: 'deepseek-chat' } } : { presetConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' } }) };
  }
}

export const hostedStoryInput = (product: HostedStoryFixtureProduct = 'battle', roles = true): HostedStoryChapterInput => {
  const draft = storyDraft(); draft.settings.writeArenaHistory = roles; draft.settings.writeCurrentState = roles;
  const seed = captureDesktopStorySeed(draft, product);
  const session: StorySessionSnapshot = { id: 'hosted-story-session', title: '未命名连续战报', createdAt: 100, updatedAt: 100,
    source: StorySourceSchema.parse({ mode: draft.battleMode, language: draft.selectedLanguage, storyLength: draft.storyLength, generationMode: 'stream' }),
    seed, workingCombatants: seed.combatants, chapterCount: 0 };
  return { product, session, requestId: 'hosted-story-request-1', operationId: 'hosted-story-chapter-1', checkpointId: 'hosted-story-checkpoint-1',
    initialCheckpointId: 'hosted-story-checkpoint-0', expectedRevision: 0, selection: { isCurrent: () => true, isInScope: () => true },
    story: { action: 'start', chapterIndex: 1, seed: { ...seed, mode: session.source.mode, language: session.source.language, storyLength: session.source.storyLength },
      chapterContext: { workingCombatants: seed.combatants, recentWindow: [] }, userGuidance: '首章引导' } };
};
