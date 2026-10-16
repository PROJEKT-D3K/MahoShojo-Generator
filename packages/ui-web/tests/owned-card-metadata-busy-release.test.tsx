// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOwnedCardMetadataEditor, type OwnedCardMetadataPort, type OwnedCardMetadataRead, type OwnedCardMetadataOutcome } from '../src/cloud-save/owned-card-metadata';
const target = { id: 'c', type: 'character' as const, name: '原名称', description: '', isPublic: 0 as const, reviewStatus: 'approved' as const, hasPendingUpdate: false, version: 'a'.repeat(64) };
const card = { id: 'c', name: target.name };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
type Editor = ReturnType<typeof useOwnedCardMetadataEditor>;
let root: Root; let container: HTMLDivElement; let editor: Editor;
function Harness({ port, open = true }: { port: OwnedCardMetadataPort; open?: boolean }) { editor = useOwnedCardMetadataEditor(port, open); return null; }
const portFor = (): OwnedCardMetadataPort => ({ session: { uncertain: false }, isCurrent: () => true, read: vi.fn(async () => ({ kind: 'ready' as const, target })), write: vi.fn(async () => ({ kind: 'saved' as const })), onSaved: vi.fn() });
const ticketHost = () => {
  let ticket: object | null = null;
  const releases = vi.fn();
  return { isBusy: () => ticket !== null, releases, reset: () => { ticket = null; }, onBusyChange: vi.fn((busy: boolean) => {
    if (!busy) { ticket = null; return; }
    const owned = {}; ticket = owned;
    return () => { releases(); if (ticket === owned) ticket = null; };
  }) };
};
const start = async (stage: 'read' | 'write', port: OwnedCardMetadataPort) => {
  const pending = deferred<OwnedCardMetadataRead | OwnedCardMetadataOutcome>();
  if (stage === 'read') port.read = vi.fn(() => pending.promise as Promise<OwnedCardMetadataRead>);
  else port.write = vi.fn(() => pending.promise as Promise<OwnedCardMetadataOutcome>);
  await act(async () => root.render(<Harness port={port} />));
  let operation!: Promise<void>; await act(async () => { operation = editor.begin(card); if (stage === 'write') await operation; });
  if (stage === 'write') await act(async () => { operation = editor.save(); });
  return { pending, operation };
};
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it.each(['read', 'write'] as const)('失效卸载后的%s终态仅释放原ticket，不回显旧结果', async (stage) => {
  const host = ticketHost(); const port = { ...portFor(), onBusyChange: host.onBusyChange };
  const { pending, operation } = await start(stage, port);
  host.releases.mockClear(); port.isCurrent = () => false;
  await act(async () => root.render(null));
  expect(host.isBusy()).toBe(true); expect(host.releases).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(stage === 'read' ? { kind: 'ready', target } : { kind: 'saved' }); await operation; });
  expect(host.isBusy()).toBe(false); expect(host.releases).toHaveBeenCalledOnce();
  expect(port.onSaved).not.toHaveBeenCalled();
  if (stage === 'write') expect(port.session?.uncertain).toBe(true);
});

it.each(['read', 'write'] as const)('隐藏中的%s保持guard直到拒绝终态，不提前允许下一次操作', async (stage) => {
  const host = ticketHost(); const port = { ...portFor(), onBusyChange: host.onBusyChange };
  const { pending, operation } = await start(stage, port); host.releases.mockClear();
  await act(async () => root.render(<Harness port={port} open={false} />));
  expect(host.isBusy()).toBe(true); expect(editor.isBusy()).toBe(true); expect(host.releases).not.toHaveBeenCalled();
  await act(async () => { pending.reject(new Error('connection lost')); await operation; });
  expect(host.isBusy()).toBe(false); expect(editor.isBusy()).toBe(false); expect(host.releases).toHaveBeenCalledOnce();
  expect(port.onSaved).not.toHaveBeenCalled();
  if (stage === 'write') { expect(port.session?.uncertain).toBe(true); await act(async () => editor.save()); expect(port.write).toHaveBeenCalledOnce(); }
});

it('旧ticket迟到终态不清新作用域busy，旧成功不覆盖新编辑', async () => {
  const host = ticketHost(); const oldPort = { ...portFor(), onBusyChange: host.onBusyChange };
  const { pending: oldRead, operation: first } = await start('read', oldPort);
  oldPort.isCurrent = () => false; host.reset();
  const nextPort = { ...portFor(), onBusyChange: host.onBusyChange }; const nextRead = deferred<OwnedCardMetadataRead>(); nextPort.read = vi.fn(() => nextRead.promise);
  await act(async () => root.render(<Harness key="new" port={nextPort} />));
  let second!: Promise<void>; await act(async () => { second = editor.begin(card); });
  await act(async () => { oldRead.resolve({ kind: 'ready', target }); await first; });
  expect(host.releases).toHaveBeenCalledOnce(); expect(host.isBusy()).toBe(true); expect(editor.selection?.phase).toBe('reading');
  await act(async () => { nextRead.resolve({ kind: 'ready', target: { ...target, name: '新名称' } }); await second; });
  expect(host.isBusy()).toBe(false); expect(editor.selection?.draft.name).toBe('新名称');
});

it.each(['read', 'write'] as const)('旧式void consumer的失效%s终态不向新身份发送false', async (stage) => {
  const port = { ...portFor(), onBusyChange: vi.fn<(busy: boolean) => void>() };
  const { pending, operation } = await start(stage, port);
  port.onBusyChange.mockClear(); port.isCurrent = () => false; await act(async () => root.render(null));
  await act(async () => { pending.resolve(stage === 'read' ? { kind: 'ready', target } : { kind: 'saved' }); await operation; });
  expect(port.onBusyChange).not.toHaveBeenCalled(); expect(port.onSaved).not.toHaveBeenCalled();
});

it.each(['read', 'write'] as const)('同身份source卸载的旧式void %s沿原cleanup释放，迟到不清新busy', async (stage) => {
  let held = false; const busy = vi.fn((value: boolean) => { held = value; });
  const oldPort = { ...portFor(), onBusyChange: busy };
  const { pending, operation } = await start(stage, oldPort);
  await act(async () => root.render(null));
  expect(held).toBe(false);
  const nextPort = { ...portFor(), onBusyChange: busy }; const nextRead = deferred<OwnedCardMetadataRead>(); nextPort.read = vi.fn(() => nextRead.promise);
  await act(async () => root.render(<Harness port={nextPort} />));
  let next!: Promise<void>; await act(async () => { next = editor.begin(card); });
  busy.mockClear();
  await act(async () => { pending.resolve(stage === 'read' ? { kind: 'ready', target } : { kind: 'saved' }); await operation; });
  expect(held).toBe(true); expect(busy).not.toHaveBeenCalled(); expect(oldPort.onSaved).not.toHaveBeenCalled();
  await act(async () => { nextRead.resolve({ kind: 'ready', target }); await next; });
  expect(held).toBe(false);
});
