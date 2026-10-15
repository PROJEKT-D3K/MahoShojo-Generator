// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getOwnedCardMetadataSession, useOwnedCardMetadataEditor, type OwnedCardMetadataPort, type OwnedCardMetadataOutcome } from '../src/cloud-save/owned-card-metadata';
const target = { id: 'c', type: 'character' as const, name: '原名称', description: '原描述', isPublic: 1 as const, reviewStatus: 'approved' as const, hasPendingUpdate: false, version: 'a'.repeat(64) };
const card = { id: 'c', name: '摘要', data: '正文不得留存' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
type Editor = ReturnType<typeof useOwnedCardMetadataEditor>;
let root: Root; let container: HTMLDivElement; let editors: Record<string, Editor>;
function Harness({ id, port, open = true }: { id: string; port: OwnedCardMetadataPort; open?: boolean }) { editors[id] = useOwnedCardMetadataEditor(port, open); return null; }
const portFor = (session = getOwnedCardMetadataSession({}, 1, 7)): OwnedCardMetadataPort => ({ session, isCurrent: () => true, read: vi.fn(async () => ({ kind: 'ready' as const, target })), write: vi.fn(async () => ({ kind: 'saved' as const })), onSaved: vi.fn() });
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; editors = {}; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it.each(['saved', 'uncertain'] as const)('卸载后的%s回执不结束重挂载的未知输入，也不刷新', async (kind) => {
  const pending = deferred<OwnedCardMetadataOutcome>(); const port = portFor(); port.write = vi.fn(() => pending.promise);
  await act(async () => root.render(<Harness id="a" port={port} />));
  await act(async () => { await editors.a.begin(card); });
  await act(async () => { editors.a.change({ name: '保留草稿', description: '描述', isPublic: 1 }); });
  let write!: Promise<void>; await act(async () => { write = editors.a.save(); });
  expect(JSON.stringify(port.session)).not.toContain('正文不得留存'); expect(port.session?.edit?.target).toBeNull();
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness id="b" port={port} />));
  expect(editors.b.selection).toMatchObject({ phase: 'uncertain', draft: { name: '保留草稿' } });
  await act(async () => { pending.resolve(kind === 'saved' ? { kind } : { kind, message: '旧结果未知' }); await write; });
  expect(editors.b.selection?.phase).toBe('uncertain'); expect(port.onSaved).not.toHaveBeenCalled();
  await act(async () => editors.b.save()); expect(port.write).toHaveBeenCalledOnce();
});

it.each([{ kind: 'saved', replacement: false }, { kind: 'uncertain', replacement: false }, { kind: 'saved', replacement: true }, { kind: 'uncertain', replacement: true }] as const)('明确结束后旧$kind不复活也不认领新token（新写=$replacement）', async ({ kind, replacement }) => {
  const session = getOwnedCardMetadataSession({}, 1, 7); const a = portFor(session); const b = portFor(session);
  const first = deferred<OwnedCardMetadataOutcome>(); const second = deferred<OwnedCardMetadataOutcome>();
  a.write = vi.fn(() => first.promise); b.write = vi.fn(() => second.promise);
  await act(async () => root.render(<><Harness key="a" id="a" port={a} /></>));
  await act(async () => { await editors.a.begin(card); });
  let oldWrite!: Promise<void>; await act(async () => { oldWrite = editors.a.save(); });
  await act(async () => root.render(<><Harness key="a" id="a" port={a} /><Harness key="b" id="b" port={b} /></>));
  await act(async () => editors.b.cancel());
  expect(session).toMatchObject({ uncertain: false, owner: undefined, edit: undefined });
  let nextWrite!: Promise<void>;
  const startNext = async () => {
    await act(async () => { await editors.b.begin(card); });
    await act(async () => { nextWrite = editors.b.save(); });
  };
  if (replacement) await startNext();
  await act(async () => { first.resolve(kind === 'saved' ? { kind } : { kind, message: '旧未知' }); await oldWrite; });
  expect(session.uncertain).toBe(replacement); expect(a.onSaved).not.toHaveBeenCalled();
  if (!replacement) await startNext();
  const token = session.owner;
  await act(async () => editors.a.cancel());
  expect(session.owner).toBe(token); expect(session.uncertain).toBe(true);
  await act(async () => { second.resolve({ kind: 'uncertain', message: '新未知' }); await nextWrite; });
  expect(editors.b.selection?.phase).toBe('uncertain');
});

it('已打开的其他编辑器不能覆盖同session在途写；账号/凭据代次独立', async () => {
  const scope = {}; const session = getOwnedCardMetadataSession(scope, 1, 7); const a = portFor(session); const b = portFor(session);
  expect(getOwnedCardMetadataSession(scope, 1, 7)).toBe(session);
  const pending = deferred<OwnedCardMetadataOutcome>(); a.write = vi.fn(() => pending.promise);
  await act(async () => root.render(<><Harness id="a" port={a} /><Harness id="b" port={b} /></>));
  await act(async () => { await editors.a.begin(card); await editors.b.begin(card); });
  let writing!: Promise<void>; await act(async () => { writing = editors.a.save(); });
  const token = session.owner;
  await act(async () => editors.b.save()); expect(b.write).not.toHaveBeenCalled(); expect(session.owner).toBe(token);
  expect(getOwnedCardMetadataSession(scope, 2, 7)).toEqual({ uncertain: false });
  expect(getOwnedCardMetadataSession(scope, 2, 8)).toEqual({ uncertain: false });
  await act(async () => { pending.resolve({ kind: 'uncertain', message: '未知' }); await writing; });
});


it.each(['read', 'write'] as const)('外部open=false废止在途%s；晚回不接续旧编辑或刷新', async (stage) => {
  const port = portFor(); const pending = deferred<any>();
  if (stage === 'read') port.read = vi.fn(() => pending.promise); else port.write = vi.fn(() => pending.promise);
  const show = (open: boolean) => act(async () => root.render(<Harness id="a" port={port} open={open} />));
  await show(true);
  let operation!: Promise<void>;
  await act(async () => { operation = editors.a.begin(card); if (stage === 'write') await operation; });
  if (stage === 'write') await act(async () => { operation = editors.a.save(); });
  await show(false); await show(true);
  await act(async () => { pending.resolve(stage === 'read' ? { kind: 'ready', target } : { kind: 'saved' }); await operation; });
  expect(port.onSaved).not.toHaveBeenCalled();
  if (stage === 'read') expect(editors.a.selection).toBeNull();
  else { expect(editors.a.selection?.phase).toBe('uncertain'); expect(editors.a.selection?.target).toBeNull(); await act(async () => editors.a.save()); expect(port.write).toHaveBeenCalledOnce(); }
});
