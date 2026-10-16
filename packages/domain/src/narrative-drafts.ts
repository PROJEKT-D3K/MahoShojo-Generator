import { z } from 'zod/v3';
import { ARENA_CANONICAL_RESOURCE_LIMITS } from '@mahoshojo/contracts/arena-capabilities';
import { SafeJsonValueSchema } from '@mahoshojo/contracts/json-value';
import { normalizeNarrativeHistoryTitleFallback } from './narrative-history-operations';

export const NARRATIVE_DRAFT_ARCHIVE_KIND = 'arena-narrative-draft-archive' as const;
export const MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS = 4 * 1024 * 1024;
export const NARRATIVE_DRAFT_FAILURE_CODES = [
  'AI_OUTPUT_TRUNCATED', 'AI_STREAM_INCOMPLETE', 'AI_UPSTREAM_REQUEST_FAILED', 'AI_UPSTREAM_TIMEOUT',
] as const;

export const NarrativeDraftCompletionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server-failed'), code: z.enum(NARRATIVE_DRAFT_FAILURE_CODES) }).strict(),
  z.object({ kind: z.literal('trusted-length') }).strict(),
  z.object({ kind: z.literal('trusted-stop-metadata-invalid') }).strict(),
  z.object({ kind: z.literal('missing-terminal') }).strict(),
  z.object({ kind: z.literal('unconfirmed') }).strict(),
]);
export type NarrativeDraftCompletion = z.infer<typeof NarrativeDraftCompletionSchema>;

export const NarrativeDraftSchema = z.object({
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  title: z.string().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
  source: z.enum(['hosted', 'direct-local', 'direct-remote']),
  markdown: z.string().min(1).max(ARENA_CANONICAL_RESOURCE_LIMITS.outputContentBytes),
  completion: NarrativeDraftCompletionSchema,
}).strict().superRefine((draft, context) => {
  const hostedEvidence = draft.completion.kind === 'server-failed' || draft.completion.kind === 'unconfirmed';
  if ((draft.source === 'hosted') !== hostedEvidence) context.addIssue({ code: 'custom', message: 'draft evidence must match execution source' });
});
export type NarrativeDraft = z.infer<typeof NarrativeDraftSchema>;

export const NarrativeDraftArchiveSchema = z.object({
  kind: z.literal(NARRATIVE_DRAFT_ARCHIVE_KIND), version: z.literal(1), drafts: z.array(NarrativeDraftSchema),
}).strict().superRefine((archive, context) => {
  const ids = new Set<string>();
  for (const draft of archive.drafts) {
    if (ids.has(draft.requestId)) context.addIssue({ code: 'custom', message: 'duplicate draft request identity' });
    ids.add(draft.requestId);
  }
});
export type NarrativeDraftArchive = z.infer<typeof NarrativeDraftArchiveSchema>;

// These are the exact Arena control markers in ai-core/arena-generation/stream-meta.
// Reasoning arrives on a separate channel and must never be supplied as acceptedText.
const markers = ['MAHOSHOJO_ARENA_META', 'MAHOSHOJO_META', 'MAHOSHOJO_STREAM_META', 'MAHOSHOJO_TELEMETRY_META'];
const controlPattern = new RegExp(
  `<!---*\\s*(?:${markers.join('|')})(?=\\s|[:=\\[{]|-->|$)|^[ \\t]*(?:---+[ \\t]*)?(?:${markers.join('|')})(?=[ \\t]*(?:[:=\\[{]|\\r?$))`,
  'gimu',
);

/** Find the matching closing line; callers never search an unclosed suffix twice. */
const findFenceEnd = (text: string, from: number, run: string): number | null => {
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/gmu;
  closing.lastIndex = from;
  for (let line = closing.exec(text); line; line = closing.exec(text)) {
    if (line[1]![0] === run[0] && line[1]!.length >= run.length) return closing.lastIndex;
  }
  return null;
};

/** Linear, draft-only projection. Never changes the legacy completion/meta parser. */
export const projectNarrativeDraftMarkdown = (acceptedText: string): string | null => {
  if (typeof acceptedText !== 'string' || acceptedText.length > ARENA_CANONICAL_RESOURCE_LIMITS.outputContentBytes) return null;
  const fencePattern = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/mu;
  const pattern = new RegExp(`${controlPattern.source}|${fencePattern.source}`, 'gimu');
  const parts: string[] = [];
  const projected = () => { const text = parts.join(''); return text.trim() ? text : null; };
  let copiedThrough = 0, unclosedFence = false;
  for (let hit = pattern.exec(acceptedText); hit; hit = pattern.exec(acceptedText)) {
    if (hit[1]) {
      const run = hit[1], info = hit[2]!;
      if (!unclosedFence && (run[0] !== '`' || !info.includes('`'))) {
        const end = findFenceEnd(acceptedText, pattern.lastIndex, run);
        if (end !== null) pattern.lastIndex = end;
        else unclosedFence = true;
      }
      continue;
    }
    parts.push(acceptedText.slice(copiedThrough, hit.index));
    // A loose control suffix has no trustworthy end; keep only the safe prefix.
    if (!hit[0].startsWith('<!--')) return projected();
    const close = acceptedText.indexOf('-->', pattern.lastIndex);
    if (close < 0) return projected();
    copiedThrough = close + 3;
    pattern.lastIndex = copiedThrough;
  }
  parts.push(acceptedText.slice(copiedThrough));
  return projected();
};

export type NarrativeDraftCandidateInput = Readonly<{
  requestId: string; createdAt: string; source: NarrativeDraft['source']; acceptedText: string;
  completion: NarrativeDraftCompletion | null; reportFormat: string; generationMode: string;
  current: boolean; cancelled: boolean; completed: boolean;
}>;

/** The host must obtain evidence only after its transport/collector has accepted and sealed it. */
export const createNarrativeDraftCandidate = (input: NarrativeDraftCandidateInput): NarrativeDraft | null => {
  if (!input.current || input.cancelled || input.completed || input.reportFormat !== 'markdown'
    || input.generationMode !== 'stream' || !input.completion) return null;
  const markdown = projectNarrativeDraftMarkdown(input.acceptedText);
  if (!markdown) return null;
  const parsed = NarrativeDraftSchema.safeParse({
    requestId: input.requestId, createdAt: input.createdAt, source: input.source, markdown,
    title: normalizeNarrativeHistoryTitleFallback(markdown), completion: input.completion,
  });
  return parsed.success ? parsed.data : null;
};

/** Inspect a content envelope, never a transport terminal (whose failure may leave valid prose). */
export const hasExplicitNarrativeDraftRejection = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const hasSignal = (key: string) => Object.prototype.hasOwnProperty.call(envelope, key) && envelope[key] !== undefined
    && envelope[key] !== null && envelope[key] !== false && envelope[key] !== '';
  const isOneOf = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value);
  return hasSignal('refusal') || hasSignal('error')
    || isOneOf(envelope.type, ['error', 'refusal'])
    || isOneOf(envelope.status, ['failed', 'refused'])
    || [envelope.finishReason, envelope.finish_reason].some(reason =>
      isOneOf(reason, ['content-filter', 'content_filter', 'content-filtered', 'refusal']));
};

export type NarrativeDraftRetention =
  | { mode: 'automatic' }
  | { mode: 'explicit-only'; reason: 'unconfirmed-completion' | 'suspected-non-narrative' };

// These anchored response shapes are only a heuristic, not semantic validation.
// Do not search inside prose, quotations or code fences for refusal keywords.
const suspiciousOpenings = [
  /^(?:error|an? error occurred|request failed|upstream error|generation failed|internal server error|bad gateway|service unavailable|gateway timeout|rate limit(?: exceeded)?|HTTP\s+[45]\d\d|[45]\d\d[ \t]+(?:bad gateway|service unavailable|gateway timeout|too many requests|unauthorized|forbidden|not found))(?:$|[\s:：.!])/iu,
  /^(?:错误(?:信息)?|系统错误|生成失败|请求失败|服务(?:暂时)?不可用|上游(?:请求)?(?:失败|错误)|网络错误|连接超时|请求超时|访问被拒绝|内容被过滤)(?:$|[\s:：，。！])/u,
  /^(?:as an ai(?: language model| assistant)?[,\s]+)?(?:(?:i(?:['’]m| am) )?sorry[,!.\s]*(?:but\s+)?)?i (?:can(?:not|['’]t)|(?:am|['’]m) unable to) (?:help(?!\s+but\b)|assist|provide|generate|fulfil|fulfill|comply|complete|respond|answer|create|write|do (?:this|that))\b/iu,
  /^(?:(?:抱歉|很抱歉|对不起)[，,。！!\s]*(?:但|不过)?)?(?:我|本助手|本模型)?(?:目前|暂时)?(?:无法|不能|不便)(?:为(?:你|您))?(?:帮助|协助|提供|生成|完成|满足|处理|响应|回答|创作|继续(?:生成|创作|回答))/u,
];

/**
 * New automatic writes only. Unfamiliar refusals can be missed and first-person prose can match.
 * Never treat a non-match as semantic proof, or reject/rewrite an existing archive with this heuristic.
 */
export const classifyNarrativeDraftRetention = (draft: NarrativeDraft): NarrativeDraftRetention => {
  if (draft.completion.kind === 'unconfirmed') return { mode: 'explicit-only', reason: 'unconfirmed-completion' };
  // A Markdown title is neither proof of prose nor a reason to discard a short story.
  const opening = draft.markdown.trim().replace(/^(?:#{1,6}[ \t]+[^\n]*\n[ \t\r\n]*)+/u, '').replace(/^(?:\*\*|__)/u, '');
  let diagnosticEnvelope = false;
  if (opening.startsWith('{')) {
    try { diagnosticEnvelope = hasExplicitNarrativeDraftRejection(JSON.parse(opening)); } catch { /* Incomplete JSON is not evidence. */ }
  }
  return diagnosticEnvelope || suspiciousOpenings.some(pattern => pattern.test(opening))
    ? { mode: 'explicit-only', reason: 'suspected-non-narrative' }
    : { mode: 'automatic' };
};

export const canAutomaticallyRetainNarrativeDraft = (draft: NarrativeDraft): boolean =>
  classifyNarrativeDraftRetention(draft).mode === 'automatic';

/** No entries/templateId: old history importers must not mistake these for established facts. */
export const buildNarrativeDraftArchive = (drafts: readonly NarrativeDraft[]): NarrativeDraftArchive => ({
  kind: NARRATIVE_DRAFT_ARCHIVE_KIND, version: 1, drafts: [...drafts],
});

export const parseNarrativeDraftArchive = (value: unknown): NarrativeDraftArchive | null => {
  try {
    if (!SafeJsonValueSchema.safeParse(value).success) return null;
    const parsed = NarrativeDraftArchiveSchema.safeParse(value);
    if (!parsed.success || JSON.stringify(parsed.data).length > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS
      || parsed.data.drafts.some(draft => projectNarrativeDraftMarkdown(draft.markdown) !== draft.markdown)) return null;
    return parsed.data;
  } catch { return null; }
};

const sameDraft = (left: NarrativeDraft, right: NarrativeDraft): boolean =>
  left.requestId === right.requestId && left.title === right.title && left.createdAt === right.createdAt
  && left.source === right.source && left.markdown === right.markdown
  && left.completion.kind === right.completion.kind
  && (left.completion.kind !== 'server-failed' || right.completion.kind === 'server-failed' && left.completion.code === right.completion.code);

/** A conflicting same-request body is not a newer version. The caller retains its original state. */
export const mergeNarrativeDrafts = (
  current: readonly NarrativeDraft[], incoming: readonly NarrativeDraft[], completedRequestIds: readonly string[] = [],
): { ok: true; drafts: NarrativeDraft[] } | { ok: false; reason: 'conflict' | 'invalid' } => {
  const completed = new Set(completedRequestIds);
  const byId = new Map<string, NarrativeDraft>();
  for (const draft of [...current, ...incoming]) {
    if (completed.has(draft.requestId)) continue;
    const existing = byId.get(draft.requestId);
    if (existing && !sameDraft(existing, draft)) return { ok: false, reason: 'conflict' };
    byId.set(draft.requestId, existing ?? draft);
  }
  const archive = parseNarrativeDraftArchive(buildNarrativeDraftArchive([...byId.values()]));
  return archive ? { ok: true, drafts: archive.drafts } : { ok: false, reason: 'invalid' };
};
