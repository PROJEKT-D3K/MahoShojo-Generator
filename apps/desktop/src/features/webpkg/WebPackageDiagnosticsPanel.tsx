import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileCode2 } from 'lucide-react';

import { WebReportConsentDialogView } from '@mahoshojo/ui-web/arena-report';
import type { LocalWebPackageRecordV1 } from '@mahoshojo/local-library/web-package-record';
import {
  createWebPackageResourceSnapshot,
  unpackWebPackageZip,
} from '@mahoshojo/web-package';

import { IpcWebPackageRepository } from '../../platform/web-package-bridge';
import {
  DesktopWebPackageInstanceError,
  openFreeHtmlInIsolatedWebview,
  openWebPackageInstanceInIsolatedWebview,
} from '../../platform/webpkg-instance-bridge';
import type { RawInvokeFn, StructuredInvokeFn } from '../../platform/local-archive-bridge';

/**
 * Web Package 受限 webview（D4b / DESK-013）的设置页诊断入口。
 *
 * 放在设置而不是本地库：它是 D4b 的**验收面**，不是产品入口——真正的产品打开路径
 * （"从本地库点击一个包并运行"）归后续切片，而那条路径不该借"面板已经有按钮"提前
 * 半成品地上线。`DESK-PROD-001` 的同一原则：调试能力归设置。
 *
 * ## 它验收什么
 *
 * 点"在受限 webview 中打开"会走完整链：读 blob 里的 ZIP → `unpackWebPackageZip` 重新
 * 解包与逐文件摘要校验（不信任记录里缓存的 manifest）→ 展示实际包名/版本并逐次确认 →
 * 物化 base-only 快照 → begin/append/open 三段 → native 创建 `webpkg-<id>` 零 capability webview。
 *
 * **刻意 base-only**：生成 overlay 是运行期产物，不落进本地库记录；诊断面只验证
 * "按导入原样打开一个本地包"。overlay 合并语义的覆盖归
 * `packages/web-package` 自己的测试。
 *
 * ## 它不验收什么
 *
 * 真实 webview 的隔离事实（capability 命中、protocol 路由、permission 拒绝）只能在
 * 运行中的 Tauri 里确认——本面板让那条人工验收路径存在，但不能用"按钮能点出窗口"
 * 代替它。
 */
const describeError = (cause: unknown): string => {
  if (cause instanceof DesktopWebPackageInstanceError) return `${cause.message}（${cause.code}）`;
  if (cause instanceof Error) return cause.message;
  return '打开 Web Package 受限视图失败';
};

const tauriInvoke: StructuredInvokeFn = (command, args) => invoke(command, args as never);
const tauriRawInvoke: RawInvokeFn = (command, body, options) =>
  invoke(command, body as never, options as never);

const PACKAGE_LIST_LIMIT = 50;
const FREE_HTML_DIAGNOSTIC_ID = Symbol('free-html-diagnostic');
// 固定小型本地夹具：只验证自由 HTML 桥、页面显示及脚本交互，不发网络请求。
const FREE_HTML_DIAGNOSTIC_DOCUMENT = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>自由 HTML 合成验收</title></head>
<body><h1>自由 HTML 合成验收</h1><p>此页不含外部资源。点击按钮验证脚本交互。</p>
<button id="d4-free-html-increment" type="button">点击计数</button><p id="d4-free-html-counter">0</p>
<script>document.getElementById('d4-free-html-increment').addEventListener('click', () => {
const counter = document.getElementById('d4-free-html-counter'); counter.textContent = String(Number(counter.textContent) + 1);
});</script></body></html>`;

type PendingConsent = {
  readonly name: string;
  readonly isCurrent: () => boolean;
  readonly resolve: (accepted: boolean) => void;
} & ({ readonly kind: 'web-package'; readonly version: string } | { readonly kind: 'free-html' });

export const WebPackageDiagnosticsPanel = () => {
  const packages = useMemo(() => new IpcWebPackageRepository(tauriInvoke), []);
  const [records, setRecords] = useState<readonly LocalWebPackageRecordV1[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | symbol | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const pendingConsent = useRef<PendingConsent | null>(null);
  const lifecycle = useRef({ mounted: false, epoch: 0, flight: null as symbol | null });

  // 单一同步锁覆盖列表、逐次确认与打开；effect 世代也隔离 StrictMode 的清理/重启。
  const startOperation = useCallback(() => {
    const owner = lifecycle.current;
    if (!owner.mounted || owner.flight !== null) return null;
    const epoch = owner.epoch;
    const token = Symbol('webpkg-diagnostics');
    owner.flight = token;
    const isCurrent = () => owner.mounted && owner.epoch === epoch && owner.flight === token;
    return {
      isCurrent,
      finish: () => {
        if (!isCurrent()) return false;
        owner.flight = null;
        return true;
      },
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const operation = startOperation();
    if (!operation) return;
    setLoading(true);
    try {
      const page = await packages.list({ includeDeleted: false, limit: PACKAGE_LIST_LIMIT });
      if (!operation.isCurrent()) return;
      setRecords(page.items);
      setError(null);
    } catch (cause) {
      if (operation.isCurrent()) setError(describeError(cause));
    } finally {
      if (operation.finish()) setLoading(false);
    }
  }, [packages, startOperation]);

  useEffect(() => {
    const owner = lifecycle.current;
    owner.mounted = true;
    owner.epoch += 1;
    void refresh();
    return () => {
      owner.mounted = false;
      owner.epoch += 1;
      owner.flight = null;
      const pending = pendingConsent.current;
      pendingConsent.current = null;
      pending?.resolve(false);
    };
  }, [refresh]);

  const settleConsent = (pending: PendingConsent, accepted: boolean) => {
    // 旧对话框/同刻重复确认不能消费下一次许可，也不能越过 owner 的生命周期围栏。
    if (pendingConsent.current !== pending) return;
    pendingConsent.current = null;
    setConsent(null);
    pending.resolve(accepted && pending.isCurrent());
  };

  const openInIsolatedWebview = useCallback(
    async (record: LocalWebPackageRecordV1): Promise<void> => {
      const operation = startOperation();
      if (!operation) return;
      setBusyId(record.id);
      setError(null);
      setNotice(null);
      try {
        const archive = await packages.readArchive(record.ref.digest);
        if (!operation.isCurrent()) return;
        if (!archive) {
          throw new Error('本地库中存在记录但缺少包字节');
        }
        const base = await unpackWebPackageZip(archive);
        if (!operation.isCurrent()) return;
        // 先重验并冻结实际包，再逐次确认；不信任列表标题，也不持久保存执行许可。
        const accepted = await new Promise<boolean>((resolve) => {
          const pending: PendingConsent = {
            kind: 'web-package',
            name: base.manifest.name,
            version: base.manifest.version,
            isCurrent: operation.isCurrent,
            resolve,
          };
          pendingConsent.current = pending;
          setConsent(pending);
        });
        if (!accepted || !operation.isCurrent()) return;
        // 物化 id 是渲染层命名空间——native 的 `wpk-<N>` 由 begin 另行分配，两者刻意不混用。
        const snapshot = createWebPackageResourceSnapshot(`desktop-staging-${record.id}`, {
          base,
          overlay: null,
          readFile: (path) => base.readFile(path),
        });
        const opened = await openWebPackageInstanceInIsolatedWebview(
          tauriInvoke,
          tauriRawInvoke,
          snapshot,
          base.manifest.name,
          operation.isCurrent,
        );
        if (!operation.isCurrent()) return;
        setNotice(`已在受限 webview 打开（${opened.webviewLabel}）：${base.manifest.name}`);
      } catch (cause) {
        if (operation.isCurrent()) setError(describeError(cause));
      } finally {
        if (operation.finish()) setBusyId(null);
      }
    },
    [packages, startOperation],
  );

  const openFreeHtmlDiagnostic = async (): Promise<void> => {
    const operation = startOperation();
    if (!operation) return;
    setBusyId(FREE_HTML_DIAGNOSTIC_ID);
    setError(null);
    setNotice(null);
    try {
      const accepted = await new Promise<boolean>((resolve) => {
        const pending: PendingConsent = { kind: 'free-html', name: '自由 HTML 合成验收', isCurrent: operation.isCurrent, resolve };
        pendingConsent.current = pending;
        setConsent(pending);
      });
      if (!accepted || !operation.isCurrent()) return;
      const opened = await openFreeHtmlInIsolatedWebview(
        tauriInvoke, tauriRawInvoke, FREE_HTML_DIAGNOSTIC_DOCUMENT, '自由 HTML 合成验收', operation.isCurrent,
      );
      if (operation.isCurrent()) setNotice(`已在受限 webview 打开（${opened.webviewLabel}）：自由 HTML 合成验收`);
    } catch (cause) {
      if (operation.isCurrent()) setError(describeError(cause));
    } finally {
      if (operation.finish()) setBusyId(null);
    }
  };

  return (
    <section
      className="rounded-lg border border-(--app-border) bg-(--app-surface) p-4"
      aria-labelledby="webpkg-diagnostics-heading"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="webpkg-diagnostics-heading" className="text-sm font-medium">
            Web Package 受限 webview（诊断）
          </h2>
          <p className="mt-1 text-sm text-(--app-text-muted)">
            在独立的零权限 webview 中按导入原样打开一个本地包。资源走 maho-webpkg 只读协议；
            包内容没有任何 Desktop 命令、文件或凭据访问能力。
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-(--app-border) px-3 py-2 text-sm"
          disabled={loading || busyId !== null}
          onClick={() => void refresh()}
        >
          刷新列表
        </button>
      </header>

      <div className="mt-4 rounded border border-(--app-border) p-3 text-sm">
        <h3 className="font-medium">自由 HTML 合成验收</h3>
        <p className="mt-1 text-(--app-text-muted)">打开应用内置的小型 HTML 页面，验证显示与点击计数；不读取本地包、不加载外部资源。</p>
        <button type="button" className="mt-3 flex items-center gap-2 rounded border border-(--app-border) px-3 py-2 text-sm"
          disabled={loading || busyId !== null} onClick={() => void openFreeHtmlDiagnostic()}>
          <FileCode2 size={16} aria-hidden="true" />
          {busyId === FREE_HTML_DIAGNOSTIC_ID ? (consent ? '等待运行确认…' : '正在打开合成 HTML…') : '运行合成 HTML'}
        </button>
      </div>

      {loading && <p role="status" className="mt-3 text-sm">正在读取本地 Web 包…</p>}
      {error && <p role="alert" className="mt-3 text-sm text-(--app-accent-strong)">{error}</p>}
      {notice && <p role="status" className="mt-3 break-all text-sm">{notice}</p>}

      {!loading && !error && records.length === 0 && (
        <p className="mt-3 text-sm text-(--app-text-muted)">
          本地库中还没有 Web 包。先在本地库导入一个包，再用这里验证受限 webview。
        </p>
      )}
      {records.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {records.map((record) => (
            <li
              key={record.id}
              className="min-w-0 rounded border border-(--app-border) p-3 text-sm"
            >
              <p className="font-medium">{record.title}</p>
              <p className="mt-1 break-all text-(--app-text-muted)">
                {record.ref.id}@{record.ref.version}
              </p>
              <button
                type="button"
                className="mt-3 rounded border border-(--app-border) px-3 py-2 text-sm"
                disabled={loading || busyId !== null}
                onClick={() => void openInIsolatedWebview(record)}
              >
                {busyId === record.id ? (consent ? '等待运行确认…' : '正在校验并打开…') : '在受限 webview 中打开'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {consent ? <WebReportConsentDialogView
        open
        title={consent.kind === 'free-html' ? '运行自由 HTML（诊断）' : '运行 Web 包（诊断）'}
        executionDescription={consent.kind === 'free-html'
          ? <>将运行「{consent.name}」固定页面，使用自由 HTML 受限策略；本夹具不包含外部资源。仅确认本次运行，每次打开都需重新确认。</>
          : <>将按导入原样运行「{consent.name}」（版本 {consent.version}），不含生成覆盖层。仅确认本次运行，每次打开都需重新确认。</>}
        onCancel={() => settleConsent(consent, false)}
        onAccept={() => settleConsent(consent, true)}
      /> : null}
      <p className="mt-3 text-xs text-(--app-text-muted)">
        本地包只按导入原样打开（不含生成覆盖层）；合成 HTML 只验证自由文档路径。真实 webview 的隔离验收需在运行中的桌面应用里确认。
        离开诊断页只停止尚未派发的步骤；已派发的打开仍可能建立窗口，请单独关闭。
      </p>
    </section>
  );
};
