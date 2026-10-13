'use client';

import {
  MagicTeaPartyChatTimeline as SharedMagicTeaPartyChatTimeline,
  type MagicTeaPartyChatTimelineProps as SharedMagicTeaPartyChatTimelineProps,
} from '@mahoshojo/ui-web/magic-tea-party';
import type { MagicTeaPartyTachieAsset } from '@mahoshojo/domain/magic-tea-party/types';

import { MagicTeaPartyChatMessage } from '@/components/magic-tea-party/ChatMessage';

export type MagicTeaPartyChatTimelineProps = Omit<SharedMagicTeaPartyChatTimelineProps, 'renderMessage'> & {
  tachieAssets?: MagicTeaPartyTachieAsset[];
};

export function MagicTeaPartyChatTimeline({ tachieAssets, ...props }: MagicTeaPartyChatTimelineProps) {
  return (
    <SharedMagicTeaPartyChatTimeline
      {...props}
      renderMessage={(messageProps) => <MagicTeaPartyChatMessage {...messageProps} tachieAssets={tachieAssets} />}
    />
  );
}
