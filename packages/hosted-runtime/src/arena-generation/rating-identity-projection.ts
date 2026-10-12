import { inferTemplateId } from '@mahoshojo/domain/data-cards';

const transportKeys = new Set([
  '_cardId', '_cardName', '_cardDescription', '_cardType',
  '_isPublic', '_updatedAt', '_createdAt', '_author', '_authorName',
  '_likeCount', '_favoriteCount', '_usageCount',
]);
const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

/**
 * Rating identity, not signature verification or a replacement card document.
 * Only top-level runtime state and known transport metadata may differ. Unknown
 * fields (including underscore-prefixed and nested same-name fields) stay bound.
 */
export const projectArenaRatingIdentity = (value: unknown): Record<string, unknown> | null => {
  const record = recordOf(value);
  if (!record) return null;
  const projected = Object.fromEntries(Object.entries(record).filter(([key]) => (
    key !== 'arena_history' && key !== 'current_state' && key !== 'signature'
    && !transportKeys.has(key)
  )));
  const metadata = recordOf(projected.metadata);
  if (metadata && 'signature' in metadata) {
    const rest = { ...metadata };
    delete rest.signature;
    if (Object.keys(rest).length) projected.metadata = rest;
    else delete projected.metadata;
  }
  // The existing parser/post-battle projector fills this exact legacy default.
  if (!Object.prototype.hasOwnProperty.call(projected, 'templateId')) projected.templateId = inferTemplateId(projected);
  return projected;
};

export const canonicalArenaRatingJson = (value: unknown): string => {
  const canonicalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(canonicalize);
    const record = recordOf(item);
    if (!record) throw new Error('ARENA_RATING_IDENTITY_INVALID_JSON');
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  };
  return JSON.stringify(canonicalize(value));
};

export const digestArenaRatingJson = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalArenaRatingJson(value)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
