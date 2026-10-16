'use client';

import type { ComponentProps } from 'react';
import type DetailsModal from './DataCardDetailsModal';
import { BaseModal } from './shared/BaseModal';
import { createDeferredRenderer } from './shared/createDeferredRenderer';

const DataCardDetailsModal = createDeferredRenderer<ComponentProps<typeof DetailsModal>>(
  () => import('./DataCardDetailsModal'),
  {
    label: '数据卡详情',
    wrapFallback: (content, props) => (
      <BaseModal isOpen={props.isOpen} onClose={props.onClose} title="数据卡详情" maxWidthClassName="max-w-md">
        {content}
      </BaseModal>
    ),
  },
);

export default DataCardDetailsModal;
