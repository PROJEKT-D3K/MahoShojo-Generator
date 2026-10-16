import type { ReactNode } from 'react';

import { BaseModal } from './BaseModal';

type ImagePreviewModalProps = {
  isOpen: boolean;
  /** 预览图地址（blob/data URL 均可）；为空时按关闭处理。 */
  imageUrl: string | null;
  onClose: () => void;
  title?: ReactNode;
  hint?: ReactNode;
  imageAlt?: string;
  imageWidth?: 'half' | 'full';
  maxWidthClassName?: string;
  zIndexClassName?: string;
  closeOnBackdrop?: boolean;
  deferToOtherModals?: boolean;
  closeButtonAriaLabel?: string;
};

/**
 * 长图预览/保存弹窗（G3-r1）：Web 与 Desktop 的创作结果长按保存入口
 * 共用同一实现——对话框语义、初始焦点、焦点约束、Escape 关闭与焦点恢复
 * 全部经 `BaseModal`/`escape-stack` 统一提供，页面不再自建全屏遮罩。
 */
export function ImagePreviewModal({
  isOpen,
  imageUrl,
  onClose,
  title = '图片预览',
  hint = '💫 长按图片保存到相册',
  imageAlt = '生成结果长图',
  imageWidth = 'half',
  maxWidthClassName = 'max-w-lg',
  zIndexClassName,
  closeOnBackdrop = true,
  deferToOtherModals = false,
  closeButtonAriaLabel,
}: ImagePreviewModalProps) {
  return (
    <BaseModal
      isOpen={isOpen && Boolean(imageUrl)}
      title={title}
      onClose={onClose}
      maxWidthClassName={maxWidthClassName}
      zIndexClassName={zIndexClassName}
      closeOnBackdrop={closeOnBackdrop}
      deferToOtherModals={deferToOtherModals}
      closeButtonAriaLabel={closeButtonAriaLabel}
    >
      <p className="text-center text-sm text-gray-600 dark:text-gray-400">{hint}</p>
      <div className="flex flex-col items-center p-2">
        {imageUrl ? (
          <img src={imageUrl} alt={imageAlt} className={`mx-auto h-auto rounded-lg ${imageWidth === 'full' ? 'w-full' : 'w-1/2'}`} />
        ) : null}
      </div>
    </BaseModal>
  );
}
