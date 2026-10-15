import type { DataCardTemplate } from '../data-cards';
import { buildGeneralCharacterCardFromMarkdown, buildGeneralScenarioCardFromMarkdown } from '../markdown-card';

/** Project both partial previews and final Markdown without asserting stream completion.
 * The host owns lifecycle policy and appends trusted import metadata/raw separately.
 */
export function projectTavernStreamMarkdown(options: {
  template: DataCardTemplate;
  markdown: string;
  sourceName?: string | null;
}) {
  if (options.template === 'scenario' || options.template === 'general-scenario') {
    return buildGeneralScenarioCardFromMarkdown({
      markdown: options.markdown,
      fallbackTitle: options.sourceName,
      defaultTitle: '情景',
    });
  }

  return buildGeneralCharacterCardFromMarkdown({
    markdown: options.markdown,
    fallbackName: options.sourceName,
    defaultName: options.template === 'magical-girl' ? '魔法少女' : options.template === 'canshou' ? '残兽' : '角色',
  });
}
