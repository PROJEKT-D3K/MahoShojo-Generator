import { inferDataCardTemplate } from '../data-cards';
import type { MagicTeaPartyRole } from './types';

export type MagicTeaPartyRoleDraft = { name: string; notes: string; currentState: string };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readMagicTeaPartyRoleState(role: MagicTeaPartyRole): Record<string, unknown> | null {
  const raw = role.card.current_state ?? role.card.currentState;
  if (typeof raw !== 'string') return record(raw);
  try { return record(JSON.parse(raw)); } catch { return null; }
}

export function readMagicTeaPartyRoleDraft(role: MagicTeaPartyRole): MagicTeaPartyRoleDraft {
  const summary = readMagicTeaPartyRoleState(role)?.summary;
  return { name: role.name ?? '', notes: role.notes ?? '', currentState: typeof summary === 'string' ? summary : '' };
}

export const sameMagicTeaPartyRoleDraft = (left: MagicTeaPartyRoleDraft, right: MagicTeaPartyRoleDraft): boolean =>
  left.name === right.name && left.notes === right.notes && left.currentState === right.currentState;

/** Compare the complete JSON-like source without losing undefined keys or UTF-16 text through serialization. */
export function sameMagicTeaPartyRoleSource(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  const plain = (value: object) => Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
  if (!plain(left) || !plain(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && sameMagicTeaPartyRoleSource((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Local session editing only. Source/signature metadata is preserved, never validated or promoted. */
export function applyMagicTeaPartyRoleDraft(role: MagicTeaPartyRole, draft: MagicTeaPartyRoleDraft, updatedAt: string): MagicTeaPartyRole {
  const name = draft.name.trim();
  if (!name) throw new Error('角色名称不能为空。');
  const card = { ...role.card };
  const template = inferDataCardTemplate(card);
  if (template === 'magical-girl') card.codename = name;
  else card.name = name;
  const currentState = draft.currentState.trim();
  // An unrelated name/notes edit must not rewrite a legacy state representation or unknown fields.
  if (currentState !== readMagicTeaPartyRoleDraft(role).currentState) {
    card.current_state = { ...readMagicTeaPartyRoleState(role), summary: currentState, updated_at: updatedAt };
  }
  return { ...role, name, notes: draft.notes.trim() || undefined, card,
    template: template === 'magical-girl' || template === 'canshou' || template === 'general' ? template : role.template };
}
