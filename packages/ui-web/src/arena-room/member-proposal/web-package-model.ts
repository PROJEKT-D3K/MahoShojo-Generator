import { BUILTIN_WEB_PACKAGE_PRESETS, isBuiltinWebPackageRef } from '@mahoshojo/web-package';
import type { ArenaWebPackageSectionModel } from '../../arena/features/web-package/web-package-contract';
import type { ArenaMemberSectionInput } from './section-models';

export function buildArenaMemberWebPackageModel({ state, actions, disabled, downloadingDigest, downloadError, download, onError }: Pick<ArenaMemberSectionInput, 'state' | 'actions' | 'disabled'> & {
  downloadingDigest: string | null; downloadError: string | null; download(digest: string): Promise<void>; onError(message: string): void;
}): ArenaWebPackageSectionModel {
  const presets = BUILTIN_WEB_PACKAGE_PRESETS.map(preset => ({ digest: preset.packageRef.digest, title: preset.title,
    kind: 'builtin' as const, ref: preset.packageRef, summary: preset.description }));
  const reject = async () => { onError('多人模式不支持本地 Web 包管理'); };
  return { disabled, active: state.reportFormat === 'web',
    selected: state.webPackageRef && isBuiltinWebPackageRef(state.webPackageRef) ? presets.find(item => item.digest === state.webPackageRef?.digest) ?? null : null,
    presets, library: [], importFeedback: null, downloadError, libraryError: null, importing: false, downloadingDigest,
    busyDigest: null, saveImportedToLibrary: false,
    capabilities: { importLocal: false, downloadPreset: true, remove: true, replace: true, manageLibrary: false },
    actions: {
      select(digest) {
        if (!digest) return actions.setWebPackageRef(null);
        const ref = presets.find(item => item.digest === digest)?.ref;
        if (!ref) return onError('多人模式仅支持内置 Web 包预设');
        actions.setWebPackageRef(ref);
      },
      remove: () => actions.setWebPackageRef(null), downloadPreset: download, downloadFromLibrary: reject,
      importFile: async () => { onError('多人模式不支持导入本地 Web 包'); }, removeFromLibrary: reject,
      setSaveImportedToLibrary: () => { void reject(); }, reloadLibrary: () => {},
    },
  };
}
