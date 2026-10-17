import { withFixtureStreamReceipt } from './stream-receipt-fixture';
import { createHash, webcrypto } from 'node:crypto';
import { vi } from 'vitest';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { StorySessionHeadSchema, type StoryCommitManifest, type StoryPartKind, type StoryRecordDescriptor, type StoryChapterDocument, type StorySessionDeleteTarget } from '@mahoshojo/contracts/desktop-arena-story';
import { storyWireDigest, type StoryNativePort } from '../../src/platform/arena-story-storage';
import { createInitialArenaDraft } from '../../src/features/arena/session';
import type { PrepareStoryExecution } from '../../src/features/arena/story-session';

export const installStoryCrypto = () => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
export const storyDraft = () => ({ ...createInitialArenaDraft(), combatants: ['甲', '乙'].map((name) => ({ type: 'general-character', data: { name, content: '旧设定完整保留', extension: { signature: 'nested-keep' } }, isValid: false, isPreset: false, filename: '' })), settings: { ...createInitialArenaDraft().settings, userGuidance: '首章引导', writeArenaHistory: false, writeCurrentState: false } });
const headKeys = ['id','revision','titlePreview','titleTruncated','mode','chapterPlan','createdAt','updatedAt','chapterCount','lastChapterId'];
const headOf = (value: Record<string, unknown>) => StorySessionHeadSchema.parse(Object.fromEntries(headKeys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])));
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const token = `${'a'.repeat(32)}-${'b'.repeat(32)}`;

/** Protocol-shaped fake only: real Native/SQLite is verified separately. Uses the actual
 * prepared UTF-8 parts, descriptor checksums and bridge read/commit code unchanged. */
export class StoryFixturePort implements StoryNativePort {
  documents = new Map<string, { value: Record<string, unknown>; bytes: Uint8Array }>();
  receipts = new Map<string, unknown>();
  manifest: StoryCommitManifest | null = null;
  parts = new Map<StoryPartKind, Uint8Array[]>();
  hideReceipts = false;
  loseEndReply = false;
  failBegin = false;
  instance = 'a'.repeat(32);
  loseDeleteReply = false;
  beforeDelete?: () => Promise<void>;
  beforeDescribe?: (sessionId: string, kind: StoryRecordDescriptor['kind']) => Promise<void>;
  beforeRead?: (descriptor: StoryRecordDescriptor) => Promise<void>;
  beforeEnd?: () => Promise<void>;
  heads = () => [...this.documents.entries()].filter(([key]) => key.endsWith(':session')).map(([, doc]) => headOf(doc.value)).sort((a,b) => b.updatedAt-a.updatedAt || b.id.localeCompare(a.id));
  begin = vi.fn(async (manifest: StoryCommitManifest) => {
    if (this.failBegin) throw { code: 'maintenance-busy', message: 'busy', writeEvidence: 'not-written' };
    this.manifest = manifest; this.parts = new Map(); return { token, totalBytes: manifest.parts.reduce((sum, part) => sum + part.byteLength, 0) };
  });
  append = vi.fn(async (_token: string, kind: StoryPartKind, offset: number, bytes: Uint8Array) => {
    const list = this.parts.get(kind) ?? []; if (list.reduce((sum, value) => sum + value.byteLength, 0) !== offset) throw new Error('offset');
    list.push(Uint8Array.from(bytes)); this.parts.set(kind,list); return {token,kind,receivedBytes:offset+bytes.byteLength};
  });
  end = vi.fn(async (_token: string) => {
    await this.beforeEnd?.();
    const manifest = this.manifest!;
    const existing = this.documents.get(`${manifest.sessionId}:session`);
    if ((existing?.value.revision ?? 0) !== manifest.expectedRevision) throw { code: 'story-conflict', message: 'CAS', writeEvidence: 'not-written' };
    let session!: Record<string,unknown>, chapter!:Record<string,unknown>; const checkpointIds: string[] = [];
    for (const part of manifest.parts) {
      const bytes = Uint8Array.from(Buffer.concat(this.parts.get(part.kind)!));
      if (bytes.byteLength !== part.byteLength || sha(bytes) !== part.digest) throw new Error('bad part');
      const value = JSON.parse(new TextDecoder().decode(bytes));
      const key = part.kind === 'session' || part.kind === 'seed' ? `${manifest.sessionId}:${part.kind}` : `${manifest.sessionId}:${value.id}`;
      this.documents.set(key,{value,bytes});
      if (part.kind === 'session') session=value; if(part.kind === 'chapter') chapter=value; if(part.kind.startsWith('checkpoint')) checkpointIds.push(value.id);
    }
    const result = { version:1,operationId:manifest.operationId,sessionId:manifest.sessionId,chapterId:chapter.id,chapterIndex:chapter.index,revision:session.revision,chapterCount:session.chapterCount,checkpointIds,wireDigest:await storyWireDigest(manifest) };
    this.receipts.set(`${manifest.sessionId}:${manifest.operationId}`, result);
    if (this.loseEndReply) throw new Error('lost end');
    return result;
  });
  abort = vi.fn(async (_token: string) => {});
  receipt = vi.fn(async (sessionId: string, operationId: string) => this.hideReceipts ? null : this.receipts.get(`${sessionId}:${operationId}`) ?? null);
  listSessions = vi.fn(async (cursor: {id:string;updatedAt:number}|null,limit:number) => {
    const all=this.heads(), start=cursor?all.findIndex((head)=>head.id===cursor.id)+1:0, rows=all.slice(start,start+limit), last=rows.at(-1);
    return {rows,nextCursor:start+rows.length<all.length&&last?{id:last.id,updatedAt:last.updatedAt}:null};
  });
  chapterDocuments = (sessionId:string) => [...this.documents.entries()].filter(([key,doc])=>key.startsWith(`${sessionId}:`)&&typeof doc.value.index==='number').map(([,doc])=>doc.value as StoryChapterDocument).sort((a,b)=>a.index-b.index);
  listChapters = vi.fn(async (sessionId:string,revision:number,cursor:{id:string;index:number}|null,limit:number) => {
    const all=this.chapterDocuments(sessionId),rows=all.filter((row)=>row.index>(cursor?.index??0)).slice(0,limit).map(({id,index,action,status,titlePreview,titleTruncated,createdAt,markdownByteLength})=>({id,index,action,status,titlePreview,titleTruncated,createdAt,markdownByteLength})),last=rows.at(-1);
    return {sessionId,revision,rows,nextCursor:last&&last.index<all.length?{id:last.id,index:last.index}:null};
  });
  describe = vi.fn(async (sessionId:string,revision:number,kind:StoryRecordDescriptor['kind'],recordId:string) => {
    await this.beforeDescribe?.(sessionId, kind);
    const session=this.documents.get(`${sessionId}:session`);
    if(!session)throw {code:'story-missing',message:'missing session',writeEvidence:'not-written'};
    if(session.value.revision!==revision)throw {code:'story-stale',message:'stale session',writeEvidence:'not-written'};
    const doc=this.documents.get(`${sessionId}:${kind==='session'||kind==='seed'?kind:recordId}`);
    if(!doc)throw {code:'story-missing',message:'missing record',writeEvidence:'not-written'};
    return {instance:this.instance,sessionId,revision,kind,recordId,byteLength:doc.bytes.byteLength,digest:sha(doc.bytes)};
  });
  deleteSession = vi.fn(async (target: StorySessionDeleteTarget) => {
    await this.beforeDelete?.();
    const { session: expected } = target, session = this.documents.get(`${expected.sessionId}:session`);
    if (expected.instance !== this.instance) throw { code: 'story-stale', message: 'instance changed', writeEvidence: 'not-written' };
    if (!session) return { target, status: 'currently-absent', deletedChapterCount: 0, deletedCheckpointCount: 0 };
    if (expected.kind !== 'session' || expected.recordId !== expected.sessionId || session.value.revision !== expected.revision
      || session.bytes.byteLength !== expected.byteLength || sha(session.bytes) !== expected.digest
      || session.value.lastChapterId !== target.expectedLastChapterId || session.value.chapterCount !== target.expectedChapterCount) {
      throw { code: 'story-conflict', message: 'confirmed target changed', writeEvidence: 'not-written' };
    }
    let deletedChapterCount = 0, deletedCheckpointCount = 0;
    for (const [key, doc] of this.documents) {
      if (!key.startsWith(`${expected.sessionId}:`)) continue;
      if (typeof doc.value.index === 'number') deletedChapterCount += 1;
      if (typeof doc.value.boundaryIndex === 'number') deletedCheckpointCount += 1;
      this.documents.delete(key);
    }
    for (const key of this.receipts.keys()) if (key.startsWith(`${expected.sessionId}:`)) this.receipts.delete(key);
    if (this.loseDeleteReply) throw new Error('delete reply lost');
    return { target, status: 'deleted', deletedChapterCount, deletedCheckpointCount };
  });
  read = vi.fn(async (descriptor:StoryRecordDescriptor,offset:number,length:number) => {
    await this.beforeRead?.(descriptor); const doc=this.documents.get(`${descriptor.sessionId}:${descriptor.kind==='session'||descriptor.kind==='seed'?descriptor.kind:descriptor.recordId}`)!;
    return doc.bytes.slice(offset,offset+length);
  });
  continueState = vi.fn(async (sessionId:string,revision:number,expectedHead:string) => {
    const head=this.heads().find((item)=>item.id===sessionId)!; if(head.revision!==revision||head.lastChapterId!==expectedHead)throw new Error('stale');
    const doc=this.documents.get(`${sessionId}:session`)!.value;
    return {head,session:await this.describe(sessionId,revision,'session',sessionId),seed:await this.describe(sessionId,revision,'seed',sessionId),checkpoint:await this.describe(sessionId,revision,'checkpoint',String(doc.workingCheckpointId)),recentChapters:await Promise.all(this.chapterDocuments(sessionId).slice(-12).map((chapter)=>this.describe(sessionId,revision,'chapter',chapter.id)))};
  });
}

export const storyExecution = (rawText?: string, beforeTerminal?: () => Promise<void>) => {
  const requests: AiExecutionRequest[] = [];
  const invoke = vi.fn(withFixtureStreamReceipt(async (command:string,args?:Record<string,unknown>) => {
    if(command==='cancel_direct_ai')return true;
    if(command!=='stream_target_ai'&&command!=='stream_direct_ai')throw new Error(`unexpected ${command}`);
    const request=args!.request as AiExecutionRequest; requests.push(request);
    const content=rawText ?? `# 第${requests.length}章\n\n甲与乙继续前行，第${requests.length}次相遇。`;
    const onmessage=(args!.onEvent as {onmessage:(event:AiStreamEvent)=>void}).onmessage;
    const id={requestId:request.requestId,contractVersion:1 as const,mode:request.mode};
    let sequence=0;onmessage({...id,type:'started',sequence:sequence++});
    for(let offset=0;offset<content.length;offset+=16000)onmessage({...id,type:'text-delta',sequence:sequence++,delta:content.slice(offset,offset+16000)});
    await beforeTerminal?.();
    onmessage({...id,type:'result',sequence:sequence++,result:{...id,status:'completed',output:{text:content},finishReason:'stop',resolvedModelId:'actual-model'}});
  }));
  const prepare:PrepareStoryExecution=async(run)=>run({options:{invoke,profileId:'current-profile',providerTarget:{kind:'custom',profileId:'current-profile'},createChannel:()=>({})},intent:{mode:'direct-local',modelId:'selected-model'}});
  return {requests,invoke,prepare};
};
export const deferred = <T,>() => {let resolve!:(value:T)=>void; const promise=new Promise<T>((done)=>{resolve=done;}); return {promise,resolve};};

/** Narrow Tauri invoke-shaped adapter for actual route/binder tests. */
export const storyFixtureInvoke = (port: StoryFixturePort) => {
  const exported: Uint8Array[] = []; let declared=0;
  const invoke = async (command:string,raw?:Record<string,unknown>|Uint8Array,options?:{headers:Record<string,string>}) => {
    const args=raw as Record<string,unknown>,headers=options?.headers ?? {};
    switch(command) {
      case 'begin_arena_story_commit':return port.begin(args.manifest as StoryCommitManifest);
      case 'append_arena_story_part':return port.append(headers['x-story-token']!,headers['x-story-part'] as StoryPartKind,Number(headers['x-story-offset']),raw as Uint8Array);
      case 'end_arena_story_commit':return port.end(String(args.token));
      case 'abort_arena_story_commit':return port.abort(String(args.token));
      case 'query_arena_story_receipt':return port.receipt(String(args.sessionId),String(args.operationId));
      case 'list_arena_story_sessions':return port.listSessions(args.cursor as {id:string;updatedAt:number}|null,Number(args.limit));
      case 'list_arena_story_chapters':return port.listChapters(String(args.sessionId),Number(args.revision),args.cursor as {id:string;index:number}|null,Number(args.limit));
      case 'delete_arena_story_session':return port.deleteSession(args.target as StorySessionDeleteTarget);
      case 'describe_arena_story_record':return port.describe(String(args.sessionId),Number(args.revision),args.kind as StoryRecordDescriptor['kind'],String(args.recordId));
      case 'read_arena_story_record_chunk':return Uint8Array.from(await port.read(args.descriptor as StoryRecordDescriptor,Number(args.offset),Number(args.length))).buffer;
      case 'read_arena_story_continue_state':return port.continueState(String(args.sessionId),Number(args.revision),String(args.expectedHead));
      case 'begin_arena_story_markdown_export':declared=Number((args.manifest as {expectedByteLength:number}).expectedByteLength);exported.splice(0);return {token,expectedByteLength:declared};
      case 'append_arena_story_markdown_export':{
        const offset=exported.reduce((sum,bytes)=>sum+bytes.length,0);if(offset!==Number(headers['x-story-offset']))throw new Error('bad export offset');exported.push(Uint8Array.from(raw as Uint8Array));return{token,receivedBytes:offset+(raw as Uint8Array).byteLength};
      }
      case 'end_arena_story_markdown_export':{
        const bytes=Uint8Array.from(Buffer.concat(exported));if(bytes.length!==declared||sha(bytes)!==args.expectedDigest)throw new Error('bad export digest');return{token,absolutePath:'/fixture/exports/完整故事.md',byteLength:bytes.length};
      }
      case 'abort_arena_story_markdown_export':return;
      default:throw new Error(`unexpected story command ${command}`);
    }
  };
  return {invoke,get exported(){return Buffer.concat(exported).toString('utf8');}};
};
