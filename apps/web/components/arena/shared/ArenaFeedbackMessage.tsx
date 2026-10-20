import Link from 'next/link';

import { ArenaFeedbackView, resolveArenaFeedbackTone, type ArenaFeedbackAppearance } from '@mahoshojo/ui-web/arena';
import { getEncyclopediaHelpForError } from '@mahoshojo/ui-web/error-help';

export function ArenaFeedbackMessage({ message, appearance }: { message: string; appearance: ArenaFeedbackAppearance }) {
  const help = getEncyclopediaHelpForError({ message });
  return (
    <ArenaFeedbackView message={message} tone={resolveArenaFeedbackTone(message)} appearance={appearance}>
      {help ? (
        <div className="mt-2 text-xs opacity-95">
          <Link href={`/encyclopedia/${help.slug}`} className="underline underline-offset-2 hover:opacity-100">
            查看百科：{help.title}
          </Link>
        </div>
      ) : null}
    </ArenaFeedbackView>
  );
}
