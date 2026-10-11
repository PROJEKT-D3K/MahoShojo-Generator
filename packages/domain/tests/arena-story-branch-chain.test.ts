import { describe, expect, it } from 'vitest';
import {
  buildBattleStoryBranchChain,
  readBattleStoryBranchLink,
  type BattleStoryBranchLink,
} from '../src/arena-story-branch';

const node = (id: string, parent: BattleStoryBranchLink = { kind: 'root' }, updatedAt = 0) => ({
  id, parent, updatedAt,
});
const parent = (sessionId: string): BattleStoryBranchLink => ({ kind: 'parent', sessionId, chapterIndex: 1 });

describe('readBattleStoryBranchLink', () => {
  it('recognizes only an absent relationship as a root', () => {
    expect(readBattleStoryBranchLink(undefined)).toEqual({ kind: 'root' });
  });

  it.each([
    null, false, true, 0, 1, '', 'parent', [], {}, { kind: 'root' },
    { sessionId: 'parent' }, { chapterIndex: 1 },
    { sessionId: '', chapterIndex: 1 }, { sessionId: ' \t\n', chapterIndex: 1 },
    { sessionId: 1, chapterIndex: 1 },
    { sessionId: 'parent', chapterIndex: '1' },
    { sessionId: 'parent', chapterIndex: 0 }, { sessionId: 'parent', chapterIndex: -1 },
    { sessionId: 'parent', chapterIndex: 1.5 }, { sessionId: 'parent', chapterIndex: NaN },
    { sessionId: 'parent', chapterIndex: Infinity },
    { sessionId: 'parent', chapterIndex: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: 'parent', chapterIndex: 1, chapterTitle: null },
    { sessionId: 'parent', chapterIndex: 1, chapterTitle: 1 },
    { sessionId: 'parent', chapterIndex: 1, chapterTitle: {} },
  ])('rejects malformed relationships: %j', (value) => {
    expect(readBattleStoryBranchLink(value)).toEqual({ kind: 'invalid' });
  });

  it('preserves legacy Web identities and titles without applying native ID rules', () => {
    const value = { sessionId: '  会话/旧 ID😀  ', chapterIndex: Number.MAX_SAFE_INTEGER, chapterTitle: '  标题  ' };
    expect(readBattleStoryBranchLink(value)).toEqual({ kind: 'parent', ...value });
    expect(readBattleStoryBranchLink({ sessionId: 'parent', chapterIndex: 1, chapterTitle: '' }))
      .toEqual({ kind: 'parent', sessionId: 'parent', chapterIndex: 1, chapterTitle: '' });
    expect(readBattleStoryBranchLink({ sessionId: 'parent', chapterIndex: 1, chapterTitle: undefined }))
      .toEqual(parent('parent'));
  });

  it('projects only the relationship without reading extensions or mutating the source', () => {
    const value = Object.freeze({
      sessionId: 'parent', chapterIndex: 3,
      get extension(): never { throw new Error('opaque extension must not be read'); },
    });
    expect(readBattleStoryBranchLink(value)).toEqual({ kind: 'parent', sessionId: 'parent', chapterIndex: 3 });
    expect(value.sessionId).toBe('parent');
  });
});

describe('buildBattleStoryBranchChain', () => {
  it('returns no selection without inferring a root from known sessions', () => {
    expect(buildBattleStoryBranchChain({ sessions: [node('root')], activeSession: null }))
      .toEqual({ chain: [], children: [], stop: null });
  });

  it('includes a selected root even when absent from the supplied directory', () => {
    const activeSession = node('root');
    expect(buildBattleStoryBranchChain({ sessions: [], activeSession }))
      .toEqual({ chain: [activeSession], children: [], stop: { kind: 'root' } });
  });

  it('orders ancestors oldest-known to active regardless of directory order or timestamps', () => {
    const root = node('root', { kind: 'root' }, 300);
    const middle = node('middle', parent(root.id), 100);
    const activeSession = node('active', parent(middle.id), 200);
    expect(buildBattleStoryBranchChain({ sessions: [middle, activeSession, root], activeSession }))
      .toEqual({ chain: [root, middle, activeSession], children: [], stop: { kind: 'root' } });
  });

  it('reports an out-of-directory parent rather than treating the oldest known node as a root', () => {
    const oldestKnown = node('known', parent('outside-directory'));
    const activeSession = node('active', parent(oldestKnown.id));
    expect(buildBattleStoryBranchChain({ sessions: [oldestKnown], activeSession }))
      .toEqual({ chain: [oldestKnown, activeSession], children: [],
        stop: { kind: 'missing', sessionId: 'outside-directory' } });
  });

  it('accepts a separately loaded parent beyond a 100-entry directory without truncating input', () => {
    const activeSession = node('active', parent('outside-directory'));
    const directory = [activeSession, ...Array.from({ length: 99 }, (_, index) => node(`unrelated-${index}`))];
    expect(buildBattleStoryBranchChain({ sessions: directory, activeSession }).stop)
      .toEqual({ kind: 'missing', sessionId: 'outside-directory' });
    const loadedParent = node('outside-directory');
    const result = buildBattleStoryBranchChain({ sessions: [...directory, loadedParent], activeSession });
    expect(result.chain).toEqual([loadedParent, activeSession]);
    expect(result.stop).toEqual({ kind: 'root' });
    expect(result.children).toEqual([]);
  });

  it('walks a chain longer than a directory page without recursive or arbitrary depth limits', () => {
    const sessions = Array.from({ length: 101 }, (_, index) => node(`session-${index}`,
      index === 0 ? { kind: 'root' } : parent(`session-${index - 1}`)));
    const result = buildBattleStoryBranchChain({ sessions, activeSession: sessions[100] });
    expect(result.chain).toEqual(sessions);
    expect(result.stop).toEqual({ kind: 'root' });
  });

  it('stops a self-reference without listing the active session as its own child', () => {
    const activeSession = node('self', parent('self'));
    expect(buildBattleStoryBranchChain({ sessions: [activeSession], activeSession }))
      .toEqual({ chain: [activeSession], children: [], stop: { kind: 'cycle', sessionId: 'self' } });
  });

  it('stops a cycle that returns to an active session outside the directory', () => {
    const activeSession = node('active', parent('ancestor'));
    const ancestor = node('ancestor', parent(activeSession.id));
    expect(buildBattleStoryBranchChain({ sessions: [ancestor], activeSession }))
      .toEqual({ chain: [ancestor, activeSession], children: [ancestor],
        stop: { kind: 'cycle', sessionId: activeSession.id } });
  });

  it('stops a multi-level cycle among ancestors without duplicating any node', () => {
    const activeSession = node('active', parent('a'));
    const a = node('a', parent('b'));
    const b = node('b', parent('c'));
    const c = node('c', parent('a'));
    expect(buildBattleStoryBranchChain({ sessions: [c, b, a], activeSession }))
      .toEqual({ chain: [c, b, a, activeSession], children: [], stop: { kind: 'cycle', sessionId: 'a' } });
  });

  it('uses the active value instead of a stale same-ID directory record', () => {
    const staleActive = node('active', parent('missing'), 1);
    const activeSession = node('active', parent('root'), 3);
    const root = node('root');
    const result = buildBattleStoryBranchChain({ sessions: [staleActive, root], activeSession });
    expect(result.chain).toEqual([root, activeSession]);
    expect(result.chain[1]).toBe(activeSession);
    expect(result.stop).toEqual({ kind: 'root' });
  });

  it('does not use a stale active record to hide a cycle', () => {
    const staleActive = node('active');
    const activeSession = node('active', parent('ancestor'));
    const ancestor = node('ancestor', parent('active'));
    const result = buildBattleStoryBranchChain({ sessions: [staleActive, ancestor], activeSession });
    expect(result.chain).toEqual([ancestor, activeSession]);
    expect(result.stop).toEqual({ kind: 'cycle', sessionId: 'active' });
  });

  it('reports an invalid relationship at the node that owns it', () => {
    const malformed = node('malformed', { kind: 'invalid' });
    const activeSession = node('active', parent(malformed.id));
    expect(buildBattleStoryBranchChain({ sessions: [malformed], activeSession }))
      .toEqual({ chain: [malformed, activeSession], children: [],
        stop: { kind: 'invalid', sessionId: malformed.id } });
    expect(buildBattleStoryBranchChain({ sessions: [], activeSession: malformed }))
      .toEqual({ chain: [malformed], children: [], stop: { kind: 'invalid', sessionId: malformed.id } });
  });

  it('returns only known direct children by recency with a deterministic ID tie-break', () => {
    const activeSession = node('active');
    const first = node('first', parent(activeSession.id), 20);
    const tiedA = node('a', parent(activeSession.id), 10);
    const tiedZ = node('z', parent(activeSession.id), 10);
    const grandchild = node('grandchild', parent(first.id), 100);
    const unrelated = node('unrelated', parent('unknown'), 200);
    const malformed = node('malformed', { kind: 'invalid' }, 300);
    const result = buildBattleStoryBranchChain({
      sessions: [tiedZ, grandchild, unrelated, malformed, first, activeSession, tiedA], activeSession,
    });
    expect(result.children).toEqual([first, tiedA, tiedZ]);
    expect(result.chain).toEqual([activeSession]);
    expect(result.stop).toEqual({ kind: 'root' });
  });

  it('compares parent identities exactly rather than trimming them', () => {
    const root = node(' root ');
    const activeSession = node('active', parent(root.id));
    const other = node('root');
    expect(buildBattleStoryBranchChain({ sessions: [root, other], activeSession }).chain)
      .toEqual([root, activeSession]);
  });

  it('retains node references and leaves frozen inputs and opaque payloads untouched', () => {
    const opaque = { get payload(): never { throw new Error('payload must not be read'); } };
    const root = Object.freeze({ ...node('root'), opaque });
    const activeSession = Object.freeze({ ...node('active', Object.freeze(parent(root.id))), opaque });
    const child = Object.freeze({ ...node('child', Object.freeze(parent(activeSession.id))), opaque });
    const sessions = Object.freeze([child, activeSession, root]);
    const input = Object.freeze({ sessions, activeSession });
    const result = buildBattleStoryBranchChain(input);
    expect(result.chain[0]).toBe(root);
    expect(result.chain[1]).toBe(activeSession);
    expect(result.children[0]).toBe(child);
    expect(sessions).toEqual([child, activeSession, root]);
    result.chain.pop();
    result.children.pop();
    expect(sessions).toHaveLength(3);
    expect(activeSession.parent).toEqual(parent(root.id));
  });
});
