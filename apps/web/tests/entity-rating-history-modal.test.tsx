// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { EntityRatingHistoryModal } from '@/components/ranking/EntityRatingHistoryModal';

describe('EntityRatingHistoryModal', () => {
  test('渲染最近严格排位记录摘要并隐藏缺失发起者身份细节', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(
      <EntityRatingHistoryModal
        isOpen
        onClose={() => {}}
        title="最近严格排位"
        loading={false}
        error={null}
        items={[
          {
            generationId: 'gen-a',
            createdAt: '2026-04-25T10:00:00.000Z',
            appliedAt: '2026-04-25T10:00:01.000Z',
            opponent: { entityType: 'data_card', entityId: 'card-opponent', displayName: '对手甲' },
            result: 'loss',
            delta: -14,
            afterRating: 1004,
            initiator: { userId: null, username: null },
          },
        ]}
        onRetry={() => {}}
      />,
    ));
    const html = document.body.innerHTML;

    expect(html).toContain('最近严格排位');
    expect(html).toContain('对手甲');
    expect(html).toContain('负');
    expect(html).toContain('-14');
    expect(html).toContain('1004');
    expect(html).toContain('未知用户');
    expect(html).not.toContain('card-opponent');
    await act(async () => root.unmount()); container.remove();
  });
});
