// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalLibraryArchiveImportPlan, LocalLibraryArchiveImportReport } from '@mahoshojo/local-library/archive-import';
import { LocalArchiveSection, type LocalArchiveHost, type ArchiveExportOutcome } from '../src/local-archive';

const summary = {
  format: 'mahoshojo-local-library' as const, formatVersion: 2 as const,
  exportedAt: '2026-10-02T00:00:00.000Z', cardCount: 0, webPackageCount: 0,
  cardSchemaVersion: 1 as const, webPackageSchemaVersion: 1 as const,
};
const plan: LocalLibraryArchiveImportPlan = {
  summary, manifest: { ...summary, cards: [], webPackages: [] },
  manifestDigest: 'sha256:manifest', existingCardIds: [], existingWebPackageIds: [],
};
const report: LocalLibraryArchiveImportReport = { succeededCardIds: [], succeededWebPackageIds: [], skipped: [], failed: [] };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const makeHost = () => ({
  probeStorage: vi.fn(async () => null),
  runExport: vi.fn<LocalArchiveHost['runExport']>(async () => ({ location: 'archive.zip', byteLength: 10, entryCount: 0 })),
  pickArchiveBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  inspectArchive: vi.fn(async () => plan),
  applyArchive: vi.fn<LocalArchiveHost['applyArchive']>(async () => report),
  describeError: () => '归档失败',
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="archive-${id}"]`)!;
const click = (id: string) => act(async () => button(id).click());

it('keeps preflight, cancellation and one confirmed import while shared buttons remain non-submit', async () => {
  const host = makeHost();
  const pending = deferred<LocalLibraryArchiveImportReport>();
  host.applyArchive.mockReturnValue(pending.promise);
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  await act(async () => root.render(<form onSubmit={submit}><LocalArchiveSection host={host} maxArchiveBytes={1024} /></form>));
  expect(button('export-start').textContent).toBe('导出卡片与 Web 包归档');
  expect(container.textContent).toContain('独立图片不在此归档中');
  expect(container.textContent).not.toContain('导出整库');
  expect(button('import-confirm')).toBeNull();

  await click('import-pick');
  expect(container.querySelector('[data-testid="archive-preflight"]')?.textContent).toContain('导入前确认');
  expect(host.applyArchive).not.toHaveBeenCalled();
  await click('import-cancel');
  expect(button('import-confirm')).toBeNull();
  expect(host.applyArchive).not.toHaveBeenCalled();

  await click('import-pick');
  button('import-confirm').focus();
  expect(document.activeElement).toBe(button('import-confirm'));
  await act(async () => { button('import-confirm').click(); button('import-confirm').click(); });
  expect(host.applyArchive).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3]), plan);
  for (const id of ['export-start', 'import-pick', 'import-confirm', 'import-cancel']) {
    expect(button(id).disabled).toBe(true);
    await click(id);
  }
  expect(host.runExport).not.toHaveBeenCalled();
  expect(host.pickArchiveBytes).toHaveBeenCalledTimes(2);
  expect(host.applyArchive).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-testid="archive-preflight"]')).not.toBeNull();

  await act(async () => pending.resolve(report));
  expect(button('import-confirm')).toBeNull();
  expect(container.querySelector('[data-testid="archive-report"]')).not.toBeNull();
  await click('reset');
  expect(container.querySelector('[data-testid="archive-report"]')).toBeNull();
  expect(button('import-pick').disabled).toBe(false);
  expect(submit).not.toHaveBeenCalled();
});

it('respects host fieldset disabling without starting an import or export', async () => {
  const host = makeHost();
  await act(async () => root.render(<fieldset disabled><LocalArchiveSection host={host} maxArchiveBytes={1024} /></fieldset>));
  for (const id of ['export-start', 'import-pick']) {
    expect(button(id).matches(':disabled')).toBe(true);
    await click(id);
  }
  expect(host.runExport).not.toHaveBeenCalled();
  expect(host.pickArchiveBytes).not.toHaveBeenCalled();
});

it.each(['indeterminate', 'determinate'] as const)('keeps %s export pending until the host confirms success', async (kind) => {
  const host = makeHost();
  const pending = deferred<ArchiveExportOutcome>();
  host.runExport.mockImplementation((onProgress) => {
    onProgress?.(kind === 'determinate' ? { kind, written: 5, total: 10 } : { kind });
    return pending.promise;
  });
  await act(async () => root.render(<LocalArchiveSection host={host} maxArchiveBytes={1024} />));
  await click('export-start');
  expect(button('export-start').disabled).toBe(true);
  expect(container.querySelector(`[data-testid="archive-export-${kind}"]`)).not.toBeNull();
  expect(container.querySelector('[data-testid="archive-export-result"]')).toBeNull();
  await click('export-start');
  expect(host.runExport).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ location: 'archive.zip', byteLength: 10, entryCount: 0 }));
  expect(container.querySelector('[data-testid="archive-export-result"]')?.textContent).toContain('archive.zip');
  expect(button('export-start').disabled).toBe(false);
});
