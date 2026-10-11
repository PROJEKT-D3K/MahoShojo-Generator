import {
  STORY_CANDIDATE_FRAME_BYTES, STORY_PENDING_LIMITS, StoryPendingInputSchema, StoryPendingManifestSchema,
  StoryPendingMetaSchema, StoryPendingHeaderSchema, StoryPendingRoleResponseSchema, StoryPendingTelemetrySchema,
  StoryPendingPartKindSchema, StorySourceSchema, StorySessionHeadSchema,
  type StoryPendingSnapshot, type StoryPendingInput, type StoryPendingPartKind,
  type StoryPendingRoleResponse, type StoryPendingMeta, type StoryPendingHeader, type StoryPendingTelemetry,
  type StoryPendingFundingSnapshot, type StoryPendingAbandonOutcome, type StoryPendingExportOutcome, type StoryReceipt, type StorySessionHead,
} from '@mahoshojo/contracts/desktop-arena-story';
import { DesktopArenaHostedStoryRecoveryPointerSchema, type DesktopArenaHostedStoryRecoveryPointer } from '@mahoshojo/contracts/desktop-arena-story-transport';
import type { DesktopArenaHostedActor } from '@mahoshojo/contracts/desktop-arena-hosted';
import type { DesktopHostedSystemConfig, DesktopHostedPresetConfig } from '@mahoshojo/contracts/desktop-cloud';
import {
  createBattleStoryByteDigest, digestBattleStoryCommitValue, digestHostedStoryClientBodyIntent, freezeBattleStoryCommit,
  type BattleStorySaveEvidence,
} from '@mahoshojo/domain/arena-story-commit';
import { canResolveBattleStoryRoles, type BattleStoryRoleResolution } from '@mahoshojo/domain/arena-story-completed-output';
import type { BattleStoryArenaRequestInput } from '@mahoshojo/domain/arena-battle-story-request';
import type { BattleStoryReadToken } from '@mahoshojo/ui-web/arena-story-session-read';
import {
  StoryPendingPublishError, describeStoryPending, prepareStoryPendingJsonSource, prepareStoryPendingUpload, publishStoryPending,
  streamStoryPendingPart, readStoryPendingPartText, storyPendingKey, createStoryPendingSaveAttempt,
  prepareStoryPendingReceiptExpectation, queryStoryPendingReceipt, abandonStoryPending, exportStoryPendingOriginal,
  type StoryPendingByteSource, type PreparedStoryPendingUpload,
} from '../../platform/arena-story-pending-storage';
import type { StoryPendingNativePort, StoryPendingExportPort } from '../../platform/arena-story-pending-native';
import { prepareStoryStorageCommit, StorySaveError, type PreparedStoryCommit } from '../../platform/arena-story-storage';
import { reconcileArenaHostedStory } from '../../platform/arena-hosted-story-bridge';
import { createArenaHostedNativeSettle } from '../../platform/arena-hosted-settle';
import { controlArenaHosted, type ArenaHostedChannel, type ArenaHostedHandshake } from '../../platform/arena-hosted-bridge';
import type { InvokeFn } from '../../platform/cloud-bridge';
import type { GenerationDraftStorage } from '../generation/session';
import type { ArenaDirectPartial } from './direct';
import { DesktopArenaHostedStoryRecovery } from './hosted-story-recovery';
import { openArenaHostedStoryTransport, ARENA_HOSTED_STORY_USER_STOP, type ArenaHostedStoryTransportIntent } from './hosted-story-transport';
import { createArenaHostedStreamOutput, collectArenaHostedStreamOutput, type ArenaHostedStreamOutput } from './hosted-stream-output';
import { completeHostedStoryRecords, type StorySessionSnapshot } from './story-snapshot';

type Product = 'battle' | 'arena';
const same = (a: unknown, b: unknown) => digestBattleStoryCommitValue(a) === digestBattleStoryCommitValue(b);
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，原候选仍保留。';
export type HostedStoryExecutionTarget = {
  mode: 'hosted'; invoke: InvokeFn; actor: DesktopArenaHostedActor; modelId: string;
  systemConfig?: DesktopHostedSystemConfig; presetConfig?: DesktopHostedPresetConfig;
};
export type HostedStoryChapterInput = {
  session: StorySessionSnapshot; story: BattleStoryArenaRequestInput; product: Product;
  requestId: string; operationId: string; checkpointId: string; initialCheckpointId?: string;
  expectedRevision: number; lastInputCheckpointId?: string; selection: BattleStoryReadToken;
};
export type DesktopHostedStoryState = {
  slots: Partial<Record<Product, StoryPendingSnapshot>>; discoveryErrors: Partial<Record<Product, string>>;
  active: StoryPendingSnapshot | null; busy: 'reading' | 'model' | 'seal' | 'role' | 'save' | 'export' | 'abandon' | null;
  stopping: boolean; role: BattleStoryRoleResolution | null; outputDurable: boolean; hydrated: boolean;
  evidence: BattleStorySaveEvidence; localRetry: 'seal' | 'freeze' | 'save' | null;
  message: string | null; exportResults: StoryPendingExportOutcome[]; exportError: string | null;
  abandonment: StoryPendingAbandonOutcome | null; pointerError: string | null; actorCurrent: boolean;
};
const initialState = (): DesktopHostedStoryState => ({ slots: {}, discoveryErrors: {}, active: null, busy: null,
  stopping: false, role: null, outputDurable: false, hydrated: false, evidence: 'not-written', localRetry: null, message: null,
  exportResults: [], exportError: null, abandonment: null, pointerError: null, actorCurrent: false });
type Originals = { input: StoryPendingInput; markdown: string; reasoning: string; meta?: StoryPendingMeta;
  header?: StoryPendingHeader; telemetry?: StoryPendingTelemetry; roleResponse?: StoryPendingRoleResponse };
type LiveCandidate = { originals: Originals; session: StorySessionSnapshot | null; selection: BattleStoryReadToken;
  source: StorySessionSnapshot['source']; generationId: string | null; acceptedInMemory?: StoryPendingRoleResponse };
type RetrySeal = { prepared: PreparedStoryPendingUpload; previous: StoryPendingSnapshot | null; after: 'input' | 'completed' | 'accepted' | 'commit'; resume?: { token?: string } };
const headFromDocument = (value: unknown) => {
  const document = value as Record<string, unknown>;
  return StorySessionHeadSchema.parse(Object.fromEntries(['id', 'revision', 'titlePreview', 'titleTruncated', 'mode', 'chapterPlan', 'createdAt', 'updatedAt', 'chapterCount', 'lastChapterId']
    .filter(key => document[key] !== undefined).map(key => [key, document[key]])));
};
const rawSource = (kind: 'markdown' | 'reasoning', text: string) => {
  const bytes = new TextEncoder().encode(text), hash = createBattleStoryByteDigest(); hash.update(bytes);
  return { part: { kind, byteLength: bytes.byteLength, digest: hash.digest() }, source: { kind,
    *chunks() { for (let offset = 0; offset < bytes.byteLength; offset += STORY_CANDIDATE_FRAME_BYTES) yield bytes.subarray(offset, offset + STORY_CANDIDATE_FRAME_BYTES); },
  } satisfies StoryPendingByteSource };
};

/** Thin durable candidate coordinator. Native snapshots are the lifecycle authority;
 * C0 alone owns reconnects. Directory/selection and all Direct behavior stay with
 * DesktopArenaStorySession. No renderer-generated completion or signature proof. */
export class DesktopHostedStorySession {
  private state = initialState();
  readonly recovery: DesktopArenaHostedStoryRecovery;
  private disposed = false;
  private scope = '';
  private epoch = 0;
  private actor: DesktopArenaHostedActor | null = null;
  private controller: AbortController | null = null;
  private live: LiveCandidate | null = null;
  private retrySeal: RetrySeal | null = null;
  private saveAttempt: Awaited<ReturnType<typeof createStoryPendingSaveAttempt>> | null = null;
  private preparedCommit: PreparedStoryCommit | null = null;
  private confirmedAbandon: Parameters<typeof abandonStoryPending>[1] | null = null;
  private discoveryEpoch = 0;
  constructor(private readonly dependencies: {
    product: Product; port: StoryPendingNativePort; sink: StoryPendingExportPort; storage: GenerationDraftStorage; invoke: InvokeFn;
    now?: () => number; prepareCommit?: typeof prepareStoryStorageCommit;
    createChannel?: () => ArenaHostedChannel; wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>; maxReconnectAttempts?: number;
    onState: (state: DesktopHostedStoryState) => void;
    onResult: (result: ArenaDirectPartial, chapterIndex: number, phase: 'generating' | 'completed' | 'failed' | 'cancelled') => void;
    onSaved: (receipt: StoryReceipt, head: StorySessionHead | null, selection: BattleStoryReadToken) => Promise<void>;
    captureSelection: () => BattleStoryReadToken;
    loadBaseline: (snapshot: StoryPendingSnapshot, input: StoryPendingInput) => Promise<StorySessionSnapshot>;
  }) { this.recovery = new DesktopArenaHostedStoryRecovery(dependencies.storage, dependencies.product); }
  getSnapshot = () => this.state;
  private publish(patch: Partial<DesktopHostedStoryState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; this.dependencies.onState(this.state);
  }
  private now = () => (this.dependencies.now ?? Date.now)();
  private current = (epoch: number) => !this.disposed && epoch === this.epoch;
  private actorMatches = (snapshot = this.state.active) => !!snapshot && !!this.actor && same(snapshot.manifest.actor, this.actor);
  setContext(scope: string, actor: DesktopArenaHostedActor | null) {
    if (scope !== this.scope || !same(this.actor, actor)) { this.scope = scope; this.epoch += 1; this.controller?.abort(); }
    this.actor = actor;
    this.publish({ actorCurrent: this.actorMatches() });
  }
  isBusy = () => this.state.busy !== null || this.state.stopping;
  hasCandidate = () => Boolean(this.state.active || this.state.slots[this.dependencies.product] || this.confirmedAbandon || this.retrySeal);
  private setActive(snapshot: StoryPendingSnapshot | null) {
    this.discoveryEpoch += 1;
    const slots = { ...this.state.slots };
    if (snapshot) slots[snapshot.manifest.product] = snapshot; else delete slots[this.dependencies.product];
    this.publish({ slots, active: snapshot, actorCurrent: this.actorMatches(snapshot) });
  }
  async discover() {
    const revision = ++this.discoveryEpoch;
    const entries = await Promise.all((['battle', 'arena'] as const).map(async product => {
      try { return { product, snapshot: await describeStoryPending(this.dependencies.port, product) }; }
      catch (cause) { return { product, error: errorText(cause) }; }
    }));
    if (this.disposed || revision !== this.discoveryEpoch) return false;
    const slots: DesktopHostedStoryState['slots'] = {}, discoveryErrors: DesktopHostedStoryState['discoveryErrors'] = {};
    for (const entry of entries) { if (entry.snapshot) slots[entry.product] = entry.snapshot; if (entry.error) discoveryErrors[entry.product] = entry.error; }
    this.publish({ slots, discoveryErrors });
    return true;
  }
  private async freshActive() {
    const prior = this.state.active; if (!prior) throw new Error('没有已读取的故事候选');
    const fresh = await describeStoryPending(this.dependencies.port, prior.manifest.product);
    if (!fresh || fresh.manifest.requestId !== prior.manifest.requestId || fresh.manifest.inputDigest !== prior.manifest.inputDigest
      || !same(fresh.manifest.actor, prior.manifest.actor)) throw new Error('原故事候选已变化，请重新读取；不会操作新候选。');
    this.setActive(fresh); return fresh;
  }
  private pointer(snapshot: StoryPendingSnapshot, input: StoryPendingInput): DesktopArenaHostedStoryRecoveryPointer {
    const claim = snapshot.createClaim;
    if (!claim) throw new Error('原候选没有创建 claim，只能读取、导出或明确放弃，不能重新创建。');
    return DesktopArenaHostedStoryRecoveryPointerSchema.parse({ version: 4, purpose: 'story', delivery: 'stream',
      protocolVersion: 'arena-hosted-sse-v1', storyProtocolVersion: 'arena-story-v1', product: snapshot.manifest.product,
      requestId: snapshot.manifest.requestId, actor: snapshot.manifest.actor, format: 'markdown', battleMode: input.seed.mode,
      bodyHash: claim.clientBodyHash, inputDigest: snapshot.manifest.inputDigest, sessionId: snapshot.manifest.sessionId,
      operationId: snapshot.manifest.operationId, state: 'unknown', updatedAt: new Date(this.now()).toISOString(),
      ...(claim.observedGeneration ? { generationId: claim.observedGeneration.generationId } : {}) });
  }
  private checkedPointer(snapshot: StoryPendingSnapshot, input: StoryPendingInput) {
    const expected = this.pointer(snapshot, input), state = this.recovery.read();
    if (state.kind === 'empty') {
      if (!this.recovery.recoverFromClaim(expected)) throw new Error(this.recovery.getSnapshot().error ?? '恢复指针无法保存');
    } else if (!state.pointer || ['product','requestId','actor','bodyHash','inputDigest','sessionId','operationId','battleMode'].some(key =>
      !same(state.pointer![key as keyof typeof expected], expected[key as keyof typeof expected]))) {
      throw new Error('原恢复指针与候选不一致或不可读，已保留原指针；可读取、导出与明确放弃候选。');
    }
    const pointer = this.recovery.acceptRestore(snapshot.manifest.requestId);
    if (!pointer) throw new Error(this.recovery.getSnapshot().error ?? '原恢复指针已变化');
    return pointer;
  }
  private retained(snapshot: StoryPendingSnapshot) {
    return snapshot.manifest.parts.map(part => ({ kind: part.kind,
      chunks: () => streamStoryPendingPart(this.dependencies.port, snapshot, part.kind),
    } satisfies StoryPendingByteSource));
  }
  private async seal(prepared: PreparedStoryPendingUpload, previous: StoryPendingSnapshot | null, after: RetrySeal['after'], resume?: { token?: string }) {
    this.retrySeal = { prepared, previous, after, resume };
    this.publish({ busy: 'seal', localRetry: null });
    try {
      const snapshot = await publishStoryPending(this.dependencies.port, prepared, previous, this.controller?.signal, resume);
      this.setActive(snapshot); this.retrySeal = null; this.publish({ exportResults: [], exportError: null });
      this.publish({ outputDurable: snapshot.manifest.modelCompleted, localRetry: null });
      return snapshot;
    } catch (cause) {
      this.retrySeal = { prepared, previous, after, resume: { token: cause instanceof StoryPendingPublishError ? cause.token : resume?.token } };
      this.publish({ localRetry: 'seal', message: `${errorText(cause)} 最新尚未封存正文仅保留在当前窗口，请先导出。` });
      throw cause;
    }
  }
  async generate(input: HostedStoryChapterInput, target: HostedStoryExecutionTarget, externalSignal: AbortSignal) {
    if (this.isBusy() || this.hasCandidate()) throw new Error('请先处理原故事候选，不会覆盖或重新创建。');
    const epoch = this.epoch, controller = new AbortController(); this.controller = controller;
    this.live = null; this.retrySeal = null; this.saveAttempt = null; this.preparedCommit = null;
    const detach = () => controller.abort(externalSignal.reason); externalSignal.addEventListener('abort', detach, { once: true });
    if (externalSignal.aborted) detach();
    this.publish({ busy: 'reading', message: null, role: null, outputDurable: false, hydrated: false, evidence: 'not-written', localRetry: null, abandonment: null, exportResults: [] });
    try {
      await this.discover();
      if (!this.current(epoch) || controller.signal.aborted) return;
      if (Object.keys(this.state.discoveryErrors).length) throw new Error('原候选尚未完成读取，不会开始新生成。');
      if (this.state.slots[input.product] || Object.values(this.state.slots).some(slot => slot?.manifest.sessionId === input.session.id)) throw new Error('此产品或故事已有待处理候选，请先打开原候选。');
      if (!this.actor || !same(this.actor, target.actor)) throw new Error('生成账号已变化，未开始服务器请求。');
      const pointerState = this.recovery.read();
      if (pointerState.kind !== 'empty') throw new Error(pointerState.error ?? '原槽已有恢复记录，请先沿原入口恢复或明确替换，不能直接创建故事。');
      // Canonical capture omits undefined optional object fields just like the existing
      // JSON wire. Count/freeze first; never stringify an unbounded whole input graph.
      const inputPart = prepareStoryPendingJsonSource('input', { ...input.story, version: 1,
        generationRequestId: input.requestId, sessionId: input.session.id,
        ...(input.story.chapterPlan ? { chapterPlan: { totalChapters: input.story.chapterPlan.totalChapters } } : {}) }, STORY_PENDING_LIMITS.inputBytes);
      const decoder = new TextDecoder('utf-8', { fatal: true }), captured: string[] = [];
      for (const bytes of inputPart.source.chunks()) captured.push(decoder.decode(bytes, { stream: true }));
      captured.push(decoder.decode());
      const original = freezeBattleStoryCommit(StoryPendingInputSchema.parse(JSON.parse(captured.join(''))));
      const roleRequested = original.seed.settings.writeArenaHistory || original.seed.settings.writeCurrentState;
      const roleDigest = roleRequested ? prepareStoryPendingJsonSource('input', original.chapterContext.workingCombatants, STORY_PENDING_LIMITS.inputBytes).part.digest : null;
      const manifest = StoryPendingManifestSchema.parse({ version: 1, product: input.product, requestId: input.requestId,
        actor: target.actor, pendingRevision: 1, sessionId: input.session.id, operationId: input.operationId,
        outputCheckpointId: input.checkpointId, initialCheckpointId: input.initialCheckpointId ?? null, createdAt: input.story.action === 'start' ? input.session.createdAt : this.now(), localAssembly: { version: 1, chapterPlan: input.session.chapterPlan ?? null },
        expectedRevision: input.expectedRevision, expectedLastChapterId: input.session.lastChapterId ?? null,
        lastInputCheckpointId: input.lastInputCheckpointId ?? input.initialCheckpointId, inputDigest: inputPart.part.digest,
        writeOptions: { writeArenaHistory: original.seed.settings.writeArenaHistory, writeCurrentState: original.seed.settings.writeCurrentState,
          writeNarrativeHistory: original.seed.settings.writeNarrativeHistory },
        modelCompleted: false, roleState: roleRequested ? 'unresolved' : 'not-requested', roleInputDigest: roleDigest,
        parts: [inputPart.part], commitManifest: null });
      const funding: StoryPendingFundingSnapshot = target.presetConfig
        ? { mode: 'preset', ...target.presetConfig } : { mode: 'system', providerId: 'system', modelId: target.systemConfig?.modelId ?? 'default',
          ...(target.systemConfig?.generationOverrides ? { generationOverrides: target.systemConfig.generationOverrides } : {}) };
      const source = StorySourceSchema.parse({ ...input.session.source, providerMode: 'hosted', providerId: funding.providerId, modelId: funding.modelId });
      this.live = { originals: { input: original, markdown: '', reasoning: '' }, session: input.session, source, selection: input.selection, generationId: null };
      await this.seal(await prepareStoryPendingUpload(manifest, [inputPart.source]), null, 'input');
      if (!this.current(epoch) || controller.signal.aborted) return;
      const bodyHash = digestHostedStoryClientBodyIntent({ inputDigest: manifest.inputDigest, funding });
      const pointer = DesktopArenaHostedStoryRecoveryPointerSchema.parse({ version: 4, purpose: 'story', delivery: 'stream',
        protocolVersion: 'arena-hosted-sse-v1', storyProtocolVersion: 'arena-story-v1', product: input.product, requestId: input.requestId,
        actor: target.actor, format: 'markdown', battleMode: original.seed.mode, bodyHash, inputDigest: manifest.inputDigest,
        sessionId: manifest.sessionId, operationId: manifest.operationId, state: 'prepared', updatedAt: new Date(this.now()).toISOString() });
      if (!this.recovery.prepare(pointer)) throw new Error(this.recovery.getSnapshot().error ?? '恢复指针保存失败，未开始生成。');
      await this.runTransport({ mode: 'create', pointer, request: { operation: 'create-story-stream', product: input.product,
        requestId: input.requestId, actor: target.actor, pendingRevision: 1, inputDigest: manifest.inputDigest, clientBodyHash: bodyHash,
        ...(target.systemConfig ? { systemConfig: target.systemConfig } : {}), ...(target.presetConfig ? { presetConfig: target.presetConfig } : {}) } }, epoch, controller, true);
    } catch (cause) {
      if (this.live && this.current(epoch)) this.dependencies.onResult({ rawText: this.live.originals.markdown, markdown: this.live.originals.markdown, reasoning: this.live.originals.reasoning }, this.live.originals.input.chapterIndex, controller.signal.aborted ? 'cancelled' : 'failed');
      this.publish({ message: errorText(cause), pointerError: this.recovery.getSnapshot().error });
    }
    finally { externalSignal.removeEventListener('abort', detach); if (this.controller === controller) this.controller = null; this.publish({ busy: null }); await this.discover(); }
  }
  private output(result: ArenaHostedStreamOutput, phase: 'generating' | 'completed' | 'failed' | 'cancelled') {
    const live = this.live; if (!live) return;
    live.originals.markdown = result.markdown; live.originals.reasoning = result.reasoning;
    this.dependencies.onResult({ rawText: result.markdown, markdown: result.markdown, reasoning: result.reasoning, usage: result.usage }, live.originals.input.chapterIndex, phase);
  }
  private async runTransport(intent: ArenaHostedStoryTransportIntent, epoch: number, controller: AbortController, automatic: boolean) {
    const live = this.live; if (!live) throw new Error('故事原输入未读取');
    const output = createArenaHostedStreamOutput(), fence = createArenaHostedNativeSettle(this.dependencies.invoke);
    const previousWindow = { markdown: live.originals.markdown, reasoning: live.originals.reasoning };
    const preservesWindow = () => automatic || output.markdown.startsWith(previousWindow.markdown) && output.reasoning.startsWith(previousWindow.reasoning);
    const showOutput = (phase: 'generating' | 'completed' | 'failed' | 'cancelled') => {
      if (preservesWindow()) this.output(output, phase);
      else this.dependencies.onResult({ rawText: live.originals.markdown, markdown: live.originals.markdown,
        reasoning: live.originals.reasoning }, live.originals.input.chapterIndex, phase);
    };
    let handshake: ArenaHostedHandshake | null = null;
    this.publish({ busy: 'model', outputDurable: false, message: '正在读取原服务器请求；尚未完成的最新正文仅保留在当前窗口。' });
    const assertCurrent = () => { if (!this.current(epoch) || !this.actorMatches()) throw new Error('原账号或生成世代已变化，当前正文仍可导出。'); };
    try {
      const response = await openArenaHostedStoryTransport(fence.invoke, intent, { signal: controller.signal, isCurrent: () => this.current(epoch) && this.actorMatches(),
        createChannel: this.dependencies.createChannel, wait: this.dependencies.wait, maxReconnectAttempts: this.dependencies.maxReconnectAttempts,
        onResponse: value => { handshake = value; if (value.generationId) live.generationId = value.generationId; },
        onRecoveryState: value => {
          this.recovery.update(intent.pointer.requestId, { state: value.state, updatedAt: value.updatedAt,
            ...(value.generationId ? { generationId: value.generationId } : {}), ...(value.lastEventId ? { cursor: value.lastEventId } : {}) });
          this.publish({ pointerError: this.recovery.getSnapshot().error });
        },
      });
      await collectArenaHostedStreamOutput(response, { output, signal: controller.signal, userStopReason: ARENA_HOSTED_STORY_USER_STOP,
        assertCurrent, onEvent: () => { if (this.current(epoch) && !controller.signal.aborted) showOutput('generating'); },
        onSoftTimeout: message => this.publish({ message }) });
      // Original prose remains visible while the Native invocation is still pending.
      showOutput('generating');
      const settled = await fence.settle(controller.signal);
      assertCurrent(); controller.signal.throwIfAborted();
      if (settled.status !== 'succeeded') throw settled.status === 'failed' ? settled.error : new Error('本机订阅已脱离，尚无成功完成证明。');
      if (output.terminal?.event !== 'done' || !output.terminal.data.ok || output.terminal.data.status !== 'completed') throw new Error('未取得合格完成终态；最新正文仅在当前窗口，原请求仍可恢复。');
      if (!preservesWindow()) throw new Error('回放与当前窗口保留原文不同，原窗口全文仍保留；请先导出，再重新打开原候选核对。');
      const original = await this.freshActive(); assertCurrent(); controller.signal.throwIfAborted();
      const generationId = live.generationId ?? original.createClaim?.observedGeneration?.generationId ?? null;
      if (!generationId || (original.createClaim?.observedGeneration && original.createClaim.observedGeneration.generationId !== generationId)) throw new Error('新故事协议未取得一致的原 generationId；正文保留，不能角色同步或保存。');
      live.generationId = generationId;
      const received = handshake as ArenaHostedHandshake | null;
      if (received?.headerMeta) live.originals.header = StoryPendingHeaderSchema.parse(received.headerMeta);
      if (output.metaEvent) live.originals.meta = StoryPendingMetaSchema.parse(output.metaEvent);
      if (output.telemetry) live.originals.telemetry = StoryPendingTelemetrySchema.parse(output.telemetry);
      showOutput('completed');
      if (original.restored || original.abandonRequested || original.saveAttemptId || original.manifest.commitManifest) {
        this.publish({ message: '已读回原请求正文；此候选只读，最新回放正文仍仅在当前窗口，可导出或查询原保存回执。' }); return;
      }
      await this.sealCompleted(original);
      assertCurrent(); controller.signal.throwIfAborted();
      if (automatic) await this.resolveThenSave();
      else this.publish({ localRetry: this.state.active?.manifest.roleState === 'not-requested' || this.state.active?.manifest.roleState === 'accepted' ? 'freeze' : null, message: '完成原件已封存到本机。请明确选择角色同步或继续原本地保存，不会再次调用模型。' });
    } catch (cause) {
      if (this.current(epoch)) showOutput(controller.signal.aborted ? 'cancelled' : 'failed');
      else if (this.controller === controller && this.live === live) this.dependencies.onResult({ rawText: live.originals.markdown,
        markdown: live.originals.markdown, reasoning: live.originals.reasoning }, live.originals.input.chapterIndex, 'cancelled');
      this.publish({ message: controller.signal.aborted
        ? '已停止本机订阅；服务器可能仍在运行，最新未封存正文仅保留在当前窗口。停止服务器须另行请求并确认。'
        : `${errorText(cause)} 已收到的正文仍可导出；不会重发模型。` });
    }
  }
  private async sealCompleted(previous: StoryPendingSnapshot) {
    const live = this.live!;
    const additions = [
      ...(live.originals.markdown ? [rawSource('markdown', live.originals.markdown)] : []),
      ...(live.originals.reasoning ? [rawSource('reasoning', live.originals.reasoning)] : []),
      ...(live.originals.meta ? [prepareStoryPendingJsonSource('meta', live.originals.meta, STORY_PENDING_LIMITS.metaBytes)] : []),
      ...(live.originals.header ? [prepareStoryPendingJsonSource('header', live.originals.header, STORY_PENDING_LIMITS.headerBytes)] : []),
      ...(live.originals.telemetry ? [prepareStoryPendingJsonSource('telemetry', live.originals.telemetry, STORY_PENDING_LIMITS.telemetryBytes)] : []),
    ];
    // Replaying a completed candidate may not replace any sealed output original.
    const oldKinds = new Map(previous.manifest.parts.map(part => [part.kind, part]));
    for (const item of additions) if (oldKinds.has(item.part.kind) && !same(oldKinds.get(item.part.kind), item.part)) throw new Error('回放与已封存原件不同，两份原文保留；不能替换不可变原件。');
    const next = additions.filter(item => !oldKinds.has(item.part.kind));
    if (previous.manifest.modelCompleted && !next.length) { this.publish({ outputDurable: true }); return; }
    const parts = [...previous.manifest.parts, ...next.map(item => item.part)].sort((a, b) => StoryPendingPartKindSchema.options.indexOf(a.kind) - StoryPendingPartKindSchema.options.indexOf(b.kind));
    const sources = new Map([...this.retained(previous), ...next.map(item => item.source)].map(item => [item.kind, item]));
    await this.seal(await prepareStoryPendingUpload({ ...previous.manifest, pendingRevision: previous.manifest.pendingRevision + 1,
      modelCompleted: true, parts }, parts.map(part => sources.get(part.kind)!)), previous, 'completed');
    this.publish({ hydrated: true, role: this.state.active!.manifest.roleState === 'not-requested' ? { status: 'not-requested' } : { status: 'unresolved' } });
  }
  async openCandidate() {
    if (this.isBusy()) return;
    if (this.retrySeal || this.live?.acceptedInMemory) {
      this.publish({ message: '当前窗口仍保留原封存尝试或已收齐的角色响应，请先处理原本地封存，不能重读后重复角色请求。' }); return;
    }
    if (this.live && !this.state.outputDurable && (this.live.originals.markdown || this.live.originals.reasoning)) {
      this.publish({ message: '最新尚未封存正文只在当前窗口，请先导出；读取旧候选不能覆盖这份原文。' }); return;
    }
    const controller = new AbortController(), selection = this.dependencies.captureSelection(), epoch = this.epoch; this.controller = controller;
    let candidateRevision = this.discoveryEpoch;
    const currentRead = () => this.current(epoch) && this.controller === controller && !controller.signal.aborted && candidateRevision === this.discoveryEpoch;
    this.publish({ busy: 'reading', message: null, localRetry: null, exportResults: [], exportError: null }); this.retrySeal = null; this.saveAttempt = null; this.preparedCommit = null;
    try {
      const snapshot = await describeStoryPending(this.dependencies.port, this.dependencies.product);
      if (!currentRead()) return;
      if (!snapshot) { this.setActive(null); this.publish({ message: '本产品没有可读取的候选。' }); return; }
      this.setActive(snapshot);
      candidateRevision = this.discoveryEpoch;
      const input = StoryPendingInputSchema.parse(JSON.parse(await readStoryPendingPartText(this.dependencies.port, snapshot, 'input', controller.signal)));
      const kinds = new Set(snapshot.manifest.parts.map(part => part.kind));
      const read = (kind: StoryPendingPartKind) => readStoryPendingPartText(this.dependencies.port, snapshot, kind, controller.signal);
      const originals: Originals = { input, markdown: kinds.has('markdown') ? await read('markdown') : '', reasoning: kinds.has('reasoning') ? await read('reasoning') : '' };
      if (kinds.has('meta')) originals.meta = StoryPendingMetaSchema.parse(JSON.parse(await read('meta')));
      if (kinds.has('header')) originals.header = StoryPendingHeaderSchema.parse(JSON.parse(await read('header')));
      if (kinds.has('telemetry')) originals.telemetry = StoryPendingTelemetrySchema.parse(JSON.parse(await read('telemetry')));
      if (kinds.has('roleResponse')) originals.roleResponse = StoryPendingRoleResponseSchema.parse(JSON.parse(await read('roleResponse')));
      const funding = snapshot.createClaim?.funding;
      const source = StorySourceSchema.parse({ mode: input.seed.mode, language: input.seed.language,
        storyLength: input.seed.storyLength, ...(input.seed.customStoryLength !== undefined ? { customStoryLength: input.seed.customStoryLength } : {}),
        generationMode: 'stream', providerMode: 'hosted', ...(funding ? { providerId: funding.providerId, modelId: funding.modelId } : {}) });
      if (!currentRead()) return;
      const live: LiveCandidate = { originals, session: null, source, selection, generationId: snapshot.createClaim?.observedGeneration?.generationId ?? null };
      let baselineError: string | null = null;
      if (!snapshot.restored && !snapshot.abandonRequested && !snapshot.saveAttemptId && !snapshot.manifest.commitManifest) {
        try { live.session = await this.dependencies.loadBaseline(snapshot, input); } catch (cause) { baselineError = errorText(cause); }
      }
      if (!currentRead()) return;
      this.live = live;
      const role: BattleStoryRoleResolution = snapshot.manifest.roleState === 'not-requested' ? { status: 'not-requested' }
        : snapshot.manifest.roleState === 'accepted' ? { status: 'accepted' }
        : snapshot.manifest.roleState === 'old-roles' ? { status: 'user-kept-original', warning: '原保留旧角色决定已与提交一并封存。' }
        : { status: 'unresolved' };
      this.dependencies.onResult({ rawText: originals.markdown, markdown: originals.markdown, reasoning: originals.reasoning }, input.chapterIndex, snapshot.manifest.modelCompleted ? 'completed' : 'failed');
      this.publish({ role, hydrated: true, outputDurable: snapshot.manifest.modelCompleted, evidence: snapshot.saveAttemptId || snapshot.restored ? 'unknown' : 'not-written',
        localRetry: snapshot.manifest.commitManifest ? 'save' : snapshot.manifest.modelCompleted && this.live.session && role.status !== 'unresolved' ? 'freeze' : null,
        message: baselineError ?? (snapshot.restored ? '这是备份恢复作品，只能读取、原请求回放、查询原回执、导出或明确放弃。'
          : snapshot.abandonRequested ? '已确认放弃，原清理尚未完成；可导出并继续清理原身份。'
          : !snapshot.createClaim ? '冷恢复候选没有创建 claim。保留、导出或明确放弃后再由你新建，不能补发旧请求。'
          : '原件已读取。恢复与角色同步只沿原产品、原请求和原账号；不会再次调用模型。') });
    } catch (cause) { if (currentRead()) this.publish({ message: errorText(cause), hydrated: false }); }
    finally { if (this.controller === controller) { this.controller = null; this.publish({ busy: null }); } }
  }
  async recover() {
    if (this.isBusy() || !this.live || !this.state.active || !this.actorMatches()) return;
    const controller = new AbortController(), epoch = this.epoch; this.controller = controller;
    this.publish({ busy: 'reading' });
    try {
      const snapshot = await this.freshActive();
      if (!this.current(epoch) || this.controller !== controller || controller.signal.aborted || !this.actorMatches()) return;
      if (snapshot.abandonRequested) throw new Error('此候选已确认放弃，只能继续原清理或导出。');
      const pointer = this.checkedPointer(snapshot, this.live.originals.input);
      await this.runTransport({ mode: 'recover', pointer }, epoch, controller, false);
    } catch (cause) { this.publish({ message: errorText(cause), pointerError: this.recovery.getSnapshot().error }); }
    finally { if (this.controller === controller) { this.controller = null; this.publish({ busy: null }); } }
  }
  canResolveRoles = () => !!this.live?.session && !!this.state.active && !this.state.active.restored && !this.state.active.abandonRequested
    && !this.state.active.saveAttemptId && this.state.active.manifest.modelCompleted && !!this.live.generationId
    && canResolveBattleStoryRoles({ role: this.state.role ?? { status: 'not-requested' }, contextCurrent: this.actorMatches(), roleBusy: this.isBusy(), commitFrozen: !!this.state.active.manifest.commitManifest })
    && !this.live.acceptedInMemory && !this.retrySeal;
  canKeepOriginalRoles = () => this.canResolveRoles() || Boolean(this.retrySeal?.after === 'commit'
    && this.retrySeal.prepared.manifest.roleState === 'old-roles' && this.state.role?.status === 'unresolved'
    && !this.isBusy() && this.actorMatches() && !this.state.active?.restored && !this.state.active?.abandonRequested && !this.state.active?.saveAttemptId);
  async retryRoles() {
    if (!this.canResolveRoles()) return;
    this.controller = new AbortController();
    try { await this.resolveThenSave(); }
    finally { this.controller = null; this.publish({ busy: null }); }
  }
  async keepOriginalRoles() {
    if (!this.canKeepOriginalRoles()) return;
    this.controller = new AbortController();
    try {
      if (this.retrySeal?.after === 'commit' && this.retrySeal.prepared.manifest.roleState === 'old-roles') {
        const retry = this.retrySeal;
        // Repeat the exact frozen decision only after the user explicitly chooses it again.
        await this.seal(retry.prepared, retry.previous, retry.after, retry.resume);
        this.publish({ role: { status: 'user-kept-original', warning: '原保留旧角色决定已封存。' } });
        await this.saveFrozen();
      } else await this.freezeAndSave('user-kept-original');
    }
    catch (cause) { this.publish({ role: { status: 'unresolved' }, localRetry: null,
      message: `保留旧角色的决定尚未保存：${errorText(cause)} 完成原件仍保留，请导出或再次明确选择。` }); }
    finally { this.controller = null; this.publish({ busy: null }); }
  }
  private async resolveThenSave() {
    const snapshot = this.state.active, live = this.live; if (!snapshot || !live) return;
    const epoch = this.epoch;
    if (snapshot.restored || snapshot.abandonRequested || snapshot.saveAttemptId || !this.actorMatches()) throw new Error('当前候选仅允许读取、查询和导出。');
    if (snapshot.manifest.roleState !== 'unresolved') { await this.freezeAndSave(); return; }
    if (!live.generationId || !live.session) { this.publish({ role: { status: 'unresolved' }, message: '缺少原生成或原会话组装依据，保留完成原件；不能猜测角色或保存。' }); return; }
    this.publish({ busy: 'role', role: { status: 'unresolved' }, message: '正在同步原 generation 的角色；正文已封存，失败不会丢失。' });
    try {
      const response = await reconcileArenaHostedStory(this.dependencies.invoke, { operation: 'reconcile-story',
        ...storyPendingKey(snapshot.manifest), inputDigest: snapshot.manifest.inputDigest, actor: snapshot.manifest.actor, generationId: live.generationId },
      { signal: this.controller?.signal, createChannel: this.dependencies.createChannel, expectedCombatantCount: live.originals.input.chapterContext.workingCombatants.length });
      if (!this.current(epoch) || !this.actorMatches() || this.controller?.signal.aborted) return;
      if (!('success' in response) || !response.success) { await this.freezeAndSave('http-failure'); return; }
      // Channel + original Native invoke both settled in the role bridge before acceptance.
      live.acceptedInMemory = StoryPendingRoleResponseSchema.parse(response);
      const part = prepareStoryPendingJsonSource('roleResponse', live.acceptedInMemory, STORY_PENDING_LIMITS.roleResponseBytes);
      const parts = [...snapshot.manifest.parts, part.part].sort((a,b) => StoryPendingPartKindSchema.options.indexOf(a.kind) - StoryPendingPartKindSchema.options.indexOf(b.kind));
      const sources = new Map([...this.retained(snapshot), part.source].map(value => [value.kind, value]));
      await this.seal(await prepareStoryPendingUpload({ ...snapshot.manifest, pendingRevision: snapshot.manifest.pendingRevision + 1,
        roleState: 'accepted', parts }, parts.map(value => sources.get(value.kind)!)), snapshot, 'accepted');
      live.originals.roleResponse = live.acceptedInMemory;
      this.publish({ role: { status: 'accepted' }, localRetry: 'freeze' });
      if (!this.current(epoch) || !this.actorMatches() || this.controller?.signal.aborted) return;
      await this.freezeAndSave();
    } catch (cause) { this.publish({ role: live.acceptedInMemory ? { status: 'accepted', warning: '角色响应已收齐；仍须确认原件封存。' } : { status: 'unresolved', message: errorText(cause) },
      message: `正文已完成并封存，尚未保存章节：${errorText(cause)}` }); }
  }
  private async freezeAndSave(reason?: 'http-failure' | 'user-kept-original') {
    const snapshot = this.state.active, live = this.live;
    if (!snapshot || !live || !live.session || !this.actorMatches() || snapshot.restored || snapshot.abandonRequested || snapshot.saveAttemptId) throw new Error('原会话或当前身份不支持本地组装，原件仍可导出。');
    if (snapshot.manifest.commitManifest) { await this.saveFrozen(); return; }
    const epoch = this.epoch;
    const roleState = reason ? 'old-roles' : snapshot.manifest.roleState;
    if (roleState === 'unresolved') throw new Error('角色仍未决，请明确重试角色同步或保留旧角色。');
    this.publish({ busy: 'seal', localRetry: null });
    try {
      const records = completeHostedStoryRecords({ session: live.session, source: live.source, manifest: snapshot.manifest,
        originals: live.originals, generationId: live.generationId, roleState, fallbackReason: reason });
      const commit = await (this.dependencies.prepareCommit ?? prepareStoryStorageCommit)({ ...records,
        expectedRevision: snapshot.manifest.expectedRevision, expectedLastChapterId: snapshot.manifest.expectedLastChapterId,
        lastInputCheckpointId: snapshot.manifest.lastInputCheckpointId });
      if (!this.current(epoch) || !this.actorMatches() || this.controller?.signal.aborted) return;
      const parts = [...snapshot.manifest.parts, ...commit.manifest.parts];
      // Pending's 128 MiB covers originals PLUS commit, independently of the standalone
      // whole-commit 128 MiB preflight. Do not delete originals to make room.
      const sources: StoryPendingByteSource[] = [...this.retained(snapshot), ...commit.parts.map(({ kind, prepared }) => ({ kind, chunks: () => prepared.chunks(STORY_CANDIDATE_FRAME_BYTES) }))];
      const upload = await prepareStoryPendingUpload({ ...snapshot.manifest, pendingRevision: snapshot.manifest.pendingRevision + 1,
        roleState, parts, commitManifest: commit.manifest }, sources);
      this.preparedCommit = commit;
      await this.seal(upload, snapshot, 'commit');
      this.publish({ role: reason ? { status: reason, warning: reason === 'http-failure' ? '原角色服务明确失败，已保留旧角色。' : '已按你的选择保留旧角色。' } : this.state.role,
        localRetry: 'save' });
      if (!this.current(epoch) || !this.actorMatches() || this.controller?.signal.aborted) return;
      await this.saveFrozen();
    } catch (cause) {
      if (reason) this.publish({ role: { status: 'unresolved' }, localRetry: null, message: `保留旧角色的决定尚未封存：${errorText(cause)} 完成原件仍保留。` });
      else this.publish({ localRetry: this.retrySeal ? 'seal' : 'freeze', message: `正文与角色原件保留，未保存：${errorText(cause)} 完整原件与提交合计也受 128 MiB 限制，请导出；重新生成不能修复容量限制。` });
      throw cause;
    }
  }
  private async saveFrozen() {
    const snapshot = this.state.active, live = this.live;
    if (!snapshot?.manifest.commitManifest || !live) return;
    if (snapshot.restored || snapshot.abandonRequested || snapshot.saveAttemptId || this.state.evidence === 'unknown') { await this.queryReceipt(); return; }
    if (!this.actorMatches()) throw new Error('原账号世代已变化，请保留并导出原候选。');
    const epoch = this.epoch, controller = this.controller;
    const assertCurrent = () => {
      if (!this.current(epoch) || this.controller !== controller || this.live !== live || !this.actorMatches(snapshot)) {
        throw new Error('原账号或保存世代已变化，未继续保存。');
      }
    };
    this.publish({ busy: 'save', localRetry: null, message: '正在保存原冻结章节…' });
    try {
      this.saveAttempt ??= await createStoryPendingSaveAttempt(this.dependencies.port, snapshot, live.originals.input.chapterIndex,
        { signal: controller?.signal, assertCurrent });
      const receipt = await this.saveAttempt.saveOnce();
      await this.acceptReceipt(receipt, snapshot);
    } catch (cause) {
      const evidence = cause instanceof StorySaveError ? cause.evidence : 'unknown';
      if (evidence === 'not-written') this.saveAttempt = null; // Native proved rollback and cleared the exact durable attempt.
      this.publish({ evidence, localRetry: evidence === 'not-written' ? 'save' : null,
        message: evidence === 'unknown' ? cause instanceof StorySaveError ? cause.message : '保存状态待确认，只能查询原操作回执；缺失回执不能重新保存、另存或重新生成。' : errorText(cause) });
      try { await this.freshActive(); } catch { /* a successful lost acknowledgement may already have released active */ }
    }
  }
  private async acceptReceipt(receipt: StoryReceipt, snapshot: StoryPendingSnapshot) {
    const live = this.live; if (!live) return;
    let head: StorySessionHead | null = null;
    if (this.preparedCommit) head = headFromDocument(this.preparedCommit.parts.find(part => part.kind === 'session')!.prepared.value);
    else {
      // Capture a frozen head before save when possible; after success the pending
      // source is gone. onSaved can find the exact receipt in the committed directory.
      try { head = headFromDocument(JSON.parse(await readStoryPendingPartText(this.dependencies.port, snapshot, 'session'))); } catch { /* committed directory is the authority now */ }
    }
    const pointer = this.recovery.getSnapshot();
    if (pointer.pointer?.requestId === snapshot.manifest.requestId && pointer.raw !== null) this.recovery.clear(snapshot.manifest.requestId, pointer.raw);
    this.setActive(null); this.retrySeal = null; this.saveAttempt = null; this.preparedCommit = null;
    this.publish({ role: null, hydrated: false, outputDurable: true, evidence: 'not-written', localRetry: null, pointerError: this.recovery.getSnapshot().error,
      message: '完整章节已保存到本机故事。读取失败时只需重读，不会重新生成或保存。' });
    await this.dependencies.onSaved(receipt, head, live.selection);
  }
  async queryReceipt() {
    const snapshot = this.state.active, live = this.live;
    if (!snapshot?.manifest.commitManifest || !live || this.state.busy && this.state.busy !== 'save') return;
    this.publish({ busy: 'save', message: '正在查询原保存操作…' });
    try {
      const expected = await prepareStoryPendingReceiptExpectation(snapshot, live.originals.input.chapterIndex);
      const receipt = await queryStoryPendingReceipt(this.dependencies.port, expected);
      if (!receipt) throw new Error('尚无可核对的原操作回执；保存状态仍待确认，不授权再次保存或另存。');
      await this.acceptReceipt(receipt, snapshot);
    } catch (cause) { this.publish({ evidence: 'unknown', localRetry: null, message: errorText(cause) }); }
    finally { this.publish({ busy: null }); }
  }
  canRetryLocal = () => {
    const manifest = this.state.active?.manifest ?? this.retrySeal?.prepared.manifest;
    return !this.isBusy() && !!this.live && !!manifest && !!this.actor && same(manifest.actor, this.actor)
      && !this.state.active?.restored && !this.state.active?.abandonRequested;
  };
  async retryLocal() {
    if (!this.canRetryLocal() || !this.live) return;
    const controller = new AbortController(), epoch = this.epoch; this.controller = controller;
    try {
      if (this.state.evidence === 'unknown' || this.state.active?.saveAttemptId) { await this.queryReceipt(); return; }
      if (!this.retrySeal && this.state.active && !this.state.active.manifest.modelCompleted) {
        this.publish({ message: this.state.active.createClaim ? '原请求尚未确认完成，请显式恢复原请求；最新正文仍可导出。'
          : '冷恢复候选没有创建 claim，只能保留、导出或明确放弃；不能补发旧请求。' }); return;
      }
      if (this.retrySeal) {
        const retry = this.retrySeal;
        // The explicit old-role decision has its own action; no generic local retry can make it.
        if (retry.prepared.manifest.roleState === 'old-roles') throw new Error('请再次明确选择保留旧角色；通用重试不代替该决定。');
        await this.seal(retry.prepared, retry.previous, retry.after, retry.resume);
        if (!this.current(epoch) || controller.signal.aborted) return;
        if (retry.after === 'input') { this.publish({ message: this.state.active?.createClaim ? '原输入与创建 claim 已读回，只能显式恢复原请求。' : '原输入已封存，尚无创建 claim；不会补发请求。请导出或明确放弃后新建。' }); return; }
        if (retry.after === 'accepted' && this.live.acceptedInMemory) {
          this.live.originals.roleResponse = this.live.acceptedInMemory; this.publish({ role: { status: 'accepted' } });
        }
        if (retry.after === 'completed') this.publish({ hydrated: true });
      }
      if (this.state.active?.manifest.commitManifest) await this.saveFrozen();
      else if (this.state.active?.manifest.roleState !== 'unresolved') await this.freezeAndSave();
      else this.publish({ role: { status: 'unresolved' }, message: '完成原件已封存，请明确决定角色同步。' });
    } catch (cause) { this.publish({ message: errorText(cause) }); }
    finally { if (this.controller === controller) this.controller = null; this.publish({ busy: null }); }
  }
  /** Exact bounded input bytes captured before begin; available even if the first
   * upload acknowledgement never returned a token. This is a window-only export,
   * not evidence that Native persisted anything and not a second JSON assembly. */
  async readWindowInputOriginal(): Promise<string | null> {
    const retry = this.retrySeal;
    if (!retry || retry.after !== 'input') return null;
    const part = retry.prepared.manifest.parts.find(item => item.kind === 'input');
    const source = retry.prepared.parts.find(item => item.kind === 'input');
    if (!part || !source || part.byteLength > STORY_PENDING_LIMITS.inputBytes) throw new Error('原冻结输入无法导出');
    const decoder = new TextDecoder('utf-8', { fatal: true }), pieces: string[] = [], hash = createBattleStoryByteDigest();
    let size = 0;
    for await (const bytes of source.chunks()) {
      size += bytes.byteLength;
      if (bytes.byteLength > STORY_CANDIDATE_FRAME_BYTES || size > part.byteLength) throw new Error('原冻结输入导出超出声明');
      hash.update(bytes); pieces.push(decoder.decode(bytes, { stream: true }));
    }
    if (size !== part.byteLength || hash.digest() !== part.digest) throw new Error('原冻结输入导出核对失败');
    pieces.push(decoder.decode()); return pieces.join('');
  }
  async exportOriginals(kind?: 'markdown') {
    if (this.isBusy() || !this.state.active) return;
    const controller = new AbortController(); this.controller = controller;
    this.publish({ busy: 'export', exportResults: [], exportError: null });
    try {
      const snapshot = await this.freshActive(), key = storyPendingKey(snapshot.manifest), inputDigest = snapshot.manifest.inputDigest;
      const sources = kind ? snapshot.manifest.parts.filter(part => part.kind === kind).map(part => ({ scope: 'pending-part' as const, key, inputDigest, ...part }))
        : [...snapshot.manifest.parts.map(part => ({ scope: 'pending-part' as const, key, inputDigest, ...part })), { scope: 'pending-manifest' as const, key, inputDigest }];
      if (!sources.length) throw new Error('此候选尚无已封存正文；请使用当前窗口正文导出。');
      const results: StoryPendingExportOutcome[] = [];
      for (const source of sources) {
        const result = await exportStoryPendingOriginal(this.dependencies.sink, source, { signal: controller.signal });
        results.push(result); this.publish({ exportResults: [...results] });
      }
      this.publish({ message: kind ? '已封存候选正文已导出。尚未封存的最新窗口正文需另行导出。'
        : `全部 ${results.length} 份已封存原件及清单已导出；尚未封存的最新窗口正文需另行导出。导出不会自动放弃候选。` });
    } catch (cause) { this.publish({ exportError: controller.signal.aborted ? '导出已取消；仅列表中有最终成功回执的文件已发布。' : errorText(cause) }); }
    finally { if (this.controller === controller) this.controller = null; this.publish({ busy: null }); }
  }
  /** Caller owns the final explicit confirmation. This cannot mean server cancellation. */
  async abandonConfirmed() {
    if (this.isBusy() || !this.state.active && !this.confirmedAbandon) return;
    this.publish({ busy: 'abandon', message: '正在清理此本机候选及原恢复入口…' });
    try {
      const snapshot = this.state.active;
      this.confirmedAbandon ??= snapshot ? { key: storyPendingKey(snapshot.manifest), inputDigest: snapshot.manifest.inputDigest, actor: snapshot.manifest.actor } : null;
      if (!this.confirmedAbandon) return;
      const result = await abandonStoryPending(this.dependencies.port, this.confirmedAbandon);
      this.publish({ abandonment: result });
      if (result.state === 'abandoned') {
        const pointer = this.recovery.getSnapshot();
        if (pointer.pointer?.requestId === result.key.requestId && pointer.raw !== null) this.recovery.clear(result.key.requestId, pointer.raw);
        this.setActive(null); this.confirmedAbandon = null; this.live = null; this.retrySeal = null; this.preparedCommit = null; this.saveAttempt = null;
        this.publish({ role: null, hydrated: false, localRetry: null, pointerError: this.recovery.getSnapshot().error,
          message: result.flight === 'foreign-retained' || result.secret === 'foreign-retained'
            ? '本机候选已移除，但原生槽仍保留另一恢复身份。请沿原单次恢复入口诊断或明确替换；不能保证本产品已可新建，也不会自动替换凭据。'
            : '此本机候选已放弃；不会删除已保存章节，也不保证服务器已停止或退费。下一次新建会是全新的任务。' });
      } else { await this.freshActive(); this.publish({ message: '原放弃意图已保留，但恢复入口清理未完成；请继续清理原身份，不能保证已可新建。' }); }
      await this.discover();
    } catch (cause) { this.publish({ message: `原放弃意图仍保留，可继续清理：${errorText(cause)}` }); }
    finally { this.publish({ busy: null }); }
  }
  async requestServerStop() {
    const snapshot = this.state.active, epoch = this.epoch;
    if (this.state.stopping || this.state.busy && this.state.busy !== 'model' || !snapshot || snapshot.restored
      || snapshot.abandonRequested || !this.actorMatches() || !snapshot.createClaim && this.state.busy !== 'model') return;
    this.publish({ stopping: true });
    // Explicit control is independent of C0's reader lifetime. Its terminal event may
    // already have removed the abort listener while the Native invocation is pending.
    // Detach without the C0 user-stop marker, then send exactly one original control.
    this.controller?.abort('arena-story-stop-control');
    try {
      const fresh = await this.freshActive();
      if (!this.current(epoch) || !this.actorMatches()) return;
      const reply = await controlArenaHosted(this.dependencies.invoke, { operation: 'stop', product: snapshot.manifest.product,
        requestId: snapshot.manifest.requestId, actor: snapshot.manifest.actor, reason: 'user',
        ...(fresh.createClaim?.observedGeneration ? { generationId: fresh.createClaim.observedGeneration.generationId } : {}) });
      if (!this.current(epoch)) return;
      this.publish({ message: reply.status >= 200 && reply.status < 300 ? '服务器已受理停止请求，最终状态仍须按原请求查询；本机候选保留，不保证退费。' : '服务器未确认停止；本机候选保留，可按原请求恢复。' });
    } catch (cause) { if (this.current(epoch)) this.publish({ message: `服务器停止尚未确认：${errorText(cause)}` }); }
    finally { this.publish({ stopping: false }); }
  }
  cancelExport() { if (this.state.busy === 'export') this.controller?.abort(); }
  detach() { this.epoch += 1; this.controller?.abort(); }
  dispose() { this.detach(); this.disposed = true; }
}
