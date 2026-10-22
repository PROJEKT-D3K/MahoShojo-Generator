import { useEffect, useId, useState } from 'react';
import { Download, Eye, ImagePlus, Images, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import type { LocalImageAsset } from '@mahoshojo/local-library/image-assets';
import { Button } from '../card-library/Button';
import { BaseModal } from '../modal';
import type { LocalImagesActions, LocalImagesModel } from './controller';

export function LocalImagesPanel({ model, actions, disabled = false }: {
  model: LocalImagesModel; actions: LocalImagesActions; disabled?: boolean;
}) {
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [purging, setPurging] = useState<LocalImageAsset | null>(null);
  const unavailable = disabled || model.busy;
  useEffect(() => { setPurging(null); }, [model.view]);
  return <section data-testid="local-images-panel" aria-labelledby={`${id}-heading`} className="rounded-lg border border-(--app-border) bg-(--app-surface) p-4">
    <h2 id={`${id}-heading`} className="text-sm font-medium">本地图片</h2>
    <p className="mt-1 text-sm text-(--app-text-muted)">独立保存在这台设备上的原图。支持静态 PNG / JPEG / WebP，最多 10 MiB、单边 8192 像素、总计 16 MP；不缩放、不改写原图。</p>
    <p className="mt-1 text-sm text-(--app-text-muted)">卡片与 Web 包归档不包含这里的图片。单图导出仅携带原图，不携带名称、时间或回收站状态。</p>
    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="本地图片视图">
      <Button type="button" disabled={unavailable} aria-pressed={model.view === 'active'} variant={model.view === 'active' ? 'primary' : 'secondary'} onClick={() => actions.setView('active')}><Images className="h-4 w-4" aria-hidden="true" />图片</Button>
      <Button type="button" disabled={unavailable} aria-pressed={model.view === 'trash'} variant={model.view === 'trash' ? 'primary' : 'secondary'} onClick={() => actions.setView('trash')}><Trash2 className="h-4 w-4" aria-hidden="true" />图片回收站</Button>
      <Button type="button" disabled={unavailable} onClick={actions.reload}><RefreshCw className="h-4 w-4" aria-hidden="true" />刷新图片</Button>
    </div>
    <fieldset disabled={unavailable} className="mt-3 flex min-w-0 flex-col gap-3">
      <legend className="text-sm font-medium">上传原图</legend>
      <label htmlFor={`${id}-file`} className="flex min-w-0 flex-col gap-1 text-sm">选择图片
        <input id={`${id}-file`} aria-label="选择图片" type="file" accept="image/png,image/jpeg,image/webp" className="min-w-0 max-w-full"
          onChange={event => { const selected = event.currentTarget.files?.[0] ?? null; setFile(selected); setTitle(selected?.name ?? ''); }} />
      </label>
      <label htmlFor={`${id}-title`} className="flex min-w-0 flex-col gap-1 text-sm">图片名称（最多 240 UTF-8 字节）
        <input id={`${id}-title`} aria-label="图片名称" value={title} onChange={event => setTitle(event.currentTarget.value)} className="input-field" />
      </label>
      <div><Button type="button" disabled={!file || unavailable} onClick={() => { if (file) actions.upload(title, file); }}><ImagePlus className="h-4 w-4" aria-hidden="true" />保存原图</Button></div>
    </fieldset>
    {model.busy && <p role="status" className="mt-3 text-sm">{model.pending === 'list' ? '正在读取图片列表…' : model.pending === 'save' ? '正在保存原图，请勿关闭窗口…' : model.pending === 'preview' ? '正在读取原图…' : model.pending === 'export' ? '正在导出原图…' : '正在更新图片记录…'}</p>}
    {model.notice && <p role="status" className="mt-3 break-all text-sm">{model.notice}</p>}
    {model.error && <p role="alert" className="mt-3 text-sm text-(--app-accent-strong)">{model.error}</p>}
    {model.loadError && <p role="alert" className="mt-3 text-sm text-(--app-accent-strong)">图片列表读取失败：{model.loadError} 现有记录未被删除，请刷新重试。</p>}
    {model.status === 'ready' && model.items.length === 0 && <p className="mt-3 text-sm text-(--app-text-muted)">{model.view === 'trash' ? '图片回收站是空的。' : '还没有本地图片，选择原图后保存。'}</p>}
    <ul className="mt-3 flex flex-col gap-3">
      {model.items.map(asset => <li key={asset.id} data-testid="local-image-item" className="min-w-0 rounded-lg border border-(--app-border) p-3">
        <p className="truncate text-sm font-medium" title={asset.title}>{asset.title}</p>
        <p className="mt-1 text-xs text-(--app-text-muted)">{asset.width} × {asset.height} · {(asset.byteLength / 1024).toFixed(1)} KiB · {asset.mimeType}</p>
        <p className="mt-1 text-xs text-(--app-text-muted)">{asset.deletedAt ? '移入回收站' : '保存于'} {new Date(asset.deletedAt ?? asset.createdAt).toLocaleString()}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" disabled={unavailable} onClick={() => actions.preview(asset)}><Eye className="h-4 w-4" aria-hidden="true" />预览</Button>
          <Button type="button" disabled={unavailable} onClick={() => actions.exportImage(asset)}><Download className="h-4 w-4" aria-hidden="true" />导出原图</Button>
          {model.view === 'trash' ? <>
            <Button type="button" disabled={unavailable} onClick={() => actions.restore(asset.id)}><RotateCcw className="h-4 w-4" aria-hidden="true" />恢复图片</Button>
            <Button type="button" disabled={unavailable} variant="danger" onClick={() => setPurging(asset)}><Trash2 className="h-4 w-4" aria-hidden="true" />彻底删除图片…</Button>
          </> : <Button type="button" disabled={unavailable} onClick={() => actions.remove(asset.id)}><Trash2 className="h-4 w-4" aria-hidden="true" />移入图片回收站</Button>}
        </div>
      </li>)}
    </ul>
    {model.nextCursor && <Button type="button" disabled={unavailable} className="mt-3" onClick={actions.loadMore}><Images className="h-4 w-4" aria-hidden="true" />加载更多图片</Button>}
    <BaseModal isOpen={purging !== null} title="彻底删除图片？" onClose={() => setPurging(null)} maxWidthClassName="max-w-lg"
      footer={<div className="flex flex-wrap justify-end gap-2"><Button type="button" onClick={() => setPurging(null)}><X className="h-4 w-4" aria-hidden="true" />取消</Button><Button type="button" variant="danger" disabled={unavailable} onClick={() => { if (purging) actions.purge(purging.id); setPurging(null); }}><Trash2 className="h-4 w-4" aria-hidden="true" />确认彻底删除图片</Button></div>}>
      <p className="break-all text-sm">“{purging?.title}”将从本机图片库彻底移除，无法在应用内撤销。此前导出的原图和备份不受影响。</p>
    </BaseModal>
    <BaseModal isOpen={model.preview !== null} title={model.preview?.asset.title ?? '图片预览'} onClose={actions.closePreview}>
      {model.preview && <>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onError 处理资源载入失败，不是鼠标或键盘交互。 */}
        <img key={model.preview.url} src={model.preview.url} alt={model.preview.asset.title} className="mx-auto max-h-96 max-w-full object-contain" onError={() => actions.previewFailed(model.preview!.url)} />
      </>}
    </BaseModal>
  </section>;
}
