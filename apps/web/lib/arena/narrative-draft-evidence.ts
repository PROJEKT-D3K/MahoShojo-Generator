import { ARENA_CANONICAL_RESOURCE_LIMITS } from '@mahoshojo/contracts/arena-capabilities';
import { SafeJsonValueSchema } from '@mahoshojo/contracts/json-value';
import { NARRATIVE_DRAFT_FAILURE_CODES, type NarrativeDraftCompletion } from '@mahoshojo/domain/narrative-drafts';
import type { ArenaGenerationTerminalBoundary } from '@mahoshojo/hosted-api/arena-generation/client';
import { compareGenerationSseIds, parseGenerationSseBlock } from '@mahoshojo/hosted-api/arena-generation/sse';

const supportedEvents = new Set(['markdown', 'snapshot', 'reasoning', 'reasoning_done', 'telemetry', 'meta', 'meta_error', 'ranking', 'debug', 'error', 'done']);

/** Draft-only evidence. It never drives C0 recovery or the established success pipeline. */
export const createHostedNarrativeDraftEvidence = () => {
  let requestId: string | null = null, generationId: string | null = null, cursor: string | null = null;
  let rejected = false, sawResponse = false, boundary = false, interrupted = false, terminal = false, completed = false;
  let completion: NarrativeDraftCompletion | null = null;
  const guarded = (observe: () => void) => { try { observe(); } catch { rejected = true; } };
  return {
    onRequestIdentity: (id: string) => guarded(() => {
      if (requestId && requestId !== id) rejected = true;
      requestId = id;
    }),
    observeResponse: (response: Response) => guarded(() => {
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
      sawResponse = true;
      const actualRequest = response.headers.get('x-mahoshojo-generation-request-id');
      const actualGeneration = response.headers.get('x-mahoshojo-generation-id');
      if (!requestId || actualRequest !== requestId || !actualGeneration
        || (generationId && actualGeneration !== generationId)) rejected = true;
      generationId = actualGeneration;
      const header = response.headers.get('x-mahoshojo-stream-meta');
      if (header) {
        const meta = JSON.parse(decodeURIComponent(header));
        if (!SafeJsonValueSchema.safeParse(meta).success || meta.reportFormat === 'web'
          || meta.outputContract === 'web-document' || meta.outputContract === 'web-package-target'
          || (meta.generationId !== undefined && meta.generationId !== actualGeneration)) rejected = true;
      }
    }),
    onTerminalBoundary: (value: ArenaGenerationTerminalBoundary) => guarded(() => {
      boundary = value.kind === 'terminal';
      interrupted = value.kind === 'interrupted';
      // Only comments and whitespace already in this read buffer are harmless. No extra read is made.
      if (value.rejectedEvent || value.bufferedTail.split('\n').some(line => line.trim() && !line.startsWith(':'))) rejected = true;
    }),
    observeBlock: (block: string) => guarded(() => {
      if (block.length > ARENA_CANONICAL_RESOURCE_LIMITS.outputContentBytes * 2) { rejected = true; return; }
      const lines = block.split('\n').filter(line => line.trim() && !line.startsWith(':'));
      if (!lines.length) return;
      if (lines.filter(line => line.startsWith('id:')).length !== 1
        || lines.filter(line => line.startsWith('event:')).length !== 1
        || !lines.some(line => line.startsWith('data:'))
        || lines.some(line => !/^(id|event|data):/u.test(line))) { rejected = true; return; }
      const event = parseGenerationSseBlock(block);
      if (!event || !supportedEvents.has(event.event)) { rejected = true; return; }
      if (terminal) rejected = true;
      if (!event.id || !/^\d+-\d+$/u.test(event.id) || (cursor && compareGenerationSseIds(event.id, cursor) <= 0)) rejected = true;
      cursor = event.id;
      const payload = JSON.parse(event.data);
      if (event.event === 'ranking' && payload === null) return;
      if (!SafeJsonValueSchema.safeParse(payload).success || !payload || typeof payload !== 'object' || Array.isArray(payload)) { rejected = true; return; }
      if ((payload.generationRequestId !== undefined && payload.generationRequestId !== requestId)
        || (payload.generationId !== undefined && payload.generationId !== generationId)
        || payload.reportFormat === 'web' || payload.webPackage || payload.shouldRedirect === true) rejected = true;
      if (event.event === 'markdown' && typeof payload.chunk !== 'string') rejected = true;
      if (event.event === 'snapshot' && typeof payload.markdown !== 'string') rejected = true;
      if (event.event === 'error' || event.event === 'done') {
        terminal = true;
        const textFields = ['code', 'error', 'message', 'upstreamRequestId'];
        const boolFields = ['ok', 'replayUnavailable', 'resultAvailable'];
        const fields = [...textFields, ...boolFields, 'status', 'resultRef', 'upstreamStatus', 'persistenceWarning', 'contentRetention'];
        if (Object.keys(payload).some(key => !fields.includes(key))
          || textFields.some(key => payload[key] !== undefined && (typeof payload[key] !== 'string' || payload[key].length > 2048))
          || boolFields.some(key => payload[key] !== undefined && typeof payload[key] !== 'boolean')
          || !['failed', 'completed', 'cancelled', 'producer_lost'].includes(payload.status)
          || (event.event === 'done' && (typeof payload.ok !== 'boolean' || payload.ok !== (payload.status === 'completed')))
          || (payload.resultRef !== undefined && payload.resultRef !== null && (typeof payload.resultRef !== 'string' || payload.resultRef.length > 2048))
          || (payload.upstreamStatus !== undefined && (!Number.isInteger(payload.upstreamStatus) || payload.upstreamStatus < 100 || payload.upstreamStatus > 599))
          || (payload.persistenceWarning !== undefined && !['OUTPUT_NOT_ARCHIVED', 'PERSISTENCE_UNAVAILABLE'].includes(payload.persistenceWarning))
          || (payload.contentRetention !== undefined && payload.contentRetention !== 'expired')) { rejected = true; return; }
        completed = event.event === 'done' && payload.status === 'completed' && payload.ok !== false;
        if (payload.status === 'failed' && payload.ok !== true && NARRATIVE_DRAFT_FAILURE_CODES.includes(payload.code)) {
          completion = { kind: 'server-failed', code: payload.code };
        } else if (!completed) rejected = true;
      }
    }),
    resolve: (markdown: string) => {
      if (rejected || !sawResponse || !requestId || completed || new TextEncoder().encode(markdown).byteLength > ARENA_CANONICAL_RESOURCE_LIMITS.outputContentBytes) return null;
      if (terminal) return boundary && completion ? { requestId, completion } : null;
      return interrupted ? { requestId, completion: { kind: 'unconfirmed' } as const } : null;
    },
    completedRequest: () => completed && !rejected && sawResponse ? requestId : null,
  };
};
