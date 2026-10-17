'use client';

import { ImagePreviewModal } from '@mahoshojo/ui-web/modal';
import { lazy, useEffect, useMemo, useState } from 'react';

import BattleDataModal from '@/components/BattleDataModal';
import { DeferredChunkBoundary } from '@/components/shared/DeferredChunkBoundary';
import { createDeferredModuleLoader } from '@/lib/client/loadDeferredModule';
import Footer from '@/components/Footer';
import { ErrorMessage } from '@/components/ErrorMessage';
import { BattleLitePageView } from '@mahoshojo/ui-web/arena';
import { useAuth } from '@/lib/useAuth';
import { ONLINE_DATA_CARD_TYPES } from '@mahoshojo/contracts/data-cards';
import { getCombatantCardLibrarySelectionId } from '@mahoshojo/domain/arena-file-parser';

import { BattleActions } from '@/components/arena/components/BattleActions';
import { BattleModeSwitcher } from '@/components/arena/components/BattleModeSwitcher';
import { BattleResult } from '@/components/arena/components/BattleResult';
import { BattleStorySessionPanel } from '@/components/arena/components/BattleStorySessionPanel';
import { CombatantList } from '@/components/arena/components/CombatantList';
import { DatabaseSelector } from '@/components/arena/components/DatabaseSelector';
import { GenerationModeSwitcher } from '@/components/arena/components/GenerationModeSwitcher';
import { MaterialPanel } from '@/components/arena/components/MaterialPanel';
import { PresetSelector } from '@/components/arena/components/PresetSelector';
import { RosterUploader } from '@/components/arena/components/RosterUploader';
import { useBattleActions } from '@/components/arena/hooks/useBattleActions';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import {
  type BattleStoreState,
  type CombatantData,
  formatCombatantCount,
  hasCombatantLimit,
  MAX_COMBATANTS,
} from '@/components/arena/types';
import { getCombatantDisplayName } from '@/components/arena/utils/characterValidator';
import { ArenaCommunitySection } from '@/components/arena/shared/ArenaCommunitySection';
import { ArenaPageLinks } from '@/components/arena/shared/ArenaPageLinks';
import { ArenaRankingLinks } from '@/components/arena/shared/ArenaRankingLinks';

import { BattleLiteHeader } from './BattleLiteHeader';
import { BattleLiteInheritedContextNotice } from './BattleLiteInheritedContextNotice';
import { BattleLiteScenarioSection } from './BattleLiteScenarioSection';
import { BattleLiteStoryOptions } from './BattleLiteStoryOptions';
import { buildBattleLiteInheritedSummary } from './battle-lite-inherited-summary';
import {
  countArenaSelectedReferenceItems,
  getArenaReferenceRemainingCapacity,
  MAX_ARENA_REFERENCE_ITEMS,
} from '@/lib/arena/resource-budget';

const DataCardDetailsModal = lazy(createDeferredModuleLoader(() => import('@/components/DataCardDetailsModal')));
const ArenaRankingModal = lazy(createDeferredModuleLoader(
  () => import('@/components/arena/components/ArenaRankingModal').then((module) => ({ default: module.ArenaRankingModal })),
));

export function BattleLitePage() {
  const { isAuthenticated } = useAuth();
  const [showBattleDataModal, setShowBattleDataModal] = useState(false);
  const [dataModalType, setDataModalType] = useState<'character' | 'scenario' | 'material'>('character');
  const [selectedCombatant, setSelectedCombatant] = useState<CombatantData | null>(null);
  const [showImageModal, setShowImageModal] = useState(false);
  const [savedImageUrl, setSavedImageUrl] = useState<string | null>(null);
  const [showRankingModal, setShowRankingModal] = useState(false);
  const [hasOpenedRankingModal, setHasOpenedRankingModal] = useState(false);

  const combatants = useBattleStore((state: BattleStoreState) => state.combatants);
  const scenario = useBattleStore((state: BattleStoreState) => state.scenario);
  const auxScenarios = useBattleStore((state: BattleStoreState) => state.auxScenarios);
  const materials = useBattleStore((state: BattleStoreState) => state.materials);
  const selectedQuestionnaires = useBattleStore((state: BattleStoreState) => state.selectedQuestionnaires);
  const adjudicationEvents = useBattleStore((state: BattleStoreState) => state.adjudicationEvents);
  const battleMode = useBattleStore((state: BattleStoreState) => state.battleMode);
  const isGenerating = useBattleStore((state: BattleStoreState) => state.isGenerating);
  const isMatching = useBattleStore((state: BattleStoreState) => state.isMatching);
  const error = useBattleStore((state: BattleStoreState) => state.error);
  const storyLength = useBattleStore((state: BattleStoreState) => state.storyLength);
  const customStoryLength = useBattleStore((state: BattleStoreState) => state.customStoryLength);
  const selectedLanguage = useBattleStore((state: BattleStoreState) => state.selectedLanguage);
  const settings = useBattleStore((state: BattleStoreState) => state.settings);

  const { handleSelectDataCard, handleRandomMatch, handleToggleCombatantDataCard, handleToggleMaterialDataCard } = useBattleActions();

  const presetCombatantCount = useMemo(
    () => combatants.filter((item) => 'data' in item && (item as CombatantData).isPreset).length,
    [combatants],
  );
  const characterMaxSelected = hasCombatantLimit(MAX_COMBATANTS) ? MAX_COMBATANTS : undefined;
  const referenceItemCount = countArenaSelectedReferenceItems({
    auxScenarios,
    materials,
    selectedQuestionnaires,
  });
  const materialMaxSelected = materials.length + getArenaReferenceRemainingCapacity({
    auxScenarios,
    materials,
    selectedQuestionnaires,
  });

  const selectedCharacterSelectionIds = useMemo(
    () => combatants.map(getCombatantCardLibrarySelectionId).filter((id): id is string => id !== null),
    [combatants],
  );

  const selectedScenarioDataCardIds = useMemo(() => {
    return typeof scenario?.sourceDataCardId === 'string' && scenario.sourceDataCardId ? [scenario.sourceDataCardId] : [];
  }, [scenario?.sourceDataCardId]);

  const selectedMaterialDataCardIds = useMemo(() => {
    const out: string[] = [];
    materials.forEach((material) => {
      if (typeof material.sourceDataCardId === 'string' && material.sourceDataCardId) {
        out.push(material.sourceDataCardId);
      }
    });
    return out;
  }, [materials]);

  const inheritedSummary = useMemo(
    () =>
      buildBattleLiteInheritedSummary({
        battleMode,
        scenario,
        storyLength,
        customStoryLength,
        selectedLanguage,
        settings,
        auxScenarios,
        materials,
        selectedQuestionnaires,
        adjudicationEvents,
      }),
    [adjudicationEvents, auxScenarios, battleMode, customStoryLength, materials, scenario, selectedLanguage, selectedQuestionnaires, settings, storyLength],
  );

  const handleOpenCharacterDataModal = () => {
    setDataModalType('character');
    setShowBattleDataModal(true);
  };

  const handleOpenScenarioDataModal = () => {
    setDataModalType('scenario');
    setShowBattleDataModal(true);
  };

  const handleOpenMaterialDataModal = () => {
    setDataModalType('material');
    setShowBattleDataModal(true);
  };

  const handleOpenRankingModal = () => {
    setHasOpenedRankingModal(true);
    setShowRankingModal(true);
  };

  const handleSaveImage = (imageUrl: string) => {
    setSavedImageUrl(imageUrl);
    setShowImageModal(true);
  };

  useEffect(() => {
    return () => {
      if (savedImageUrl && savedImageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(savedImageUrl);
      }
    };
  }, [savedImageUrl]);

  return (
    <>
      <BattleLitePageView
        isGenerating={isGenerating}
        presetCountLabel={formatCombatantCount(presetCombatantCount, MAX_COMBATANTS)}
        combatantCountLabel={formatCombatantCount(combatants.length, MAX_COMBATANTS)}
        showScenario={battleMode === 'scenario'}
        hasScenario={Boolean(scenario.content)}
        materialCount={materials.length}
        referenceItemCount={referenceItemCount}
        maxReferenceItems={MAX_ARENA_REFERENCE_ITEMS}
        slots={{
          header: <BattleLiteHeader />,
          rankingLinks: <ArenaRankingLinks onOpenRankingModal={handleOpenRankingModal} />,
          pageLinks: <ArenaPageLinks variant="lite" />,
          presets: <PresetSelector />,
          database: <>                <DatabaseSelector
                  className="!mb-0"
                  title={null}
                  layout="column"
                  onOpenCharacterModal={handleOpenCharacterDataModal}
                  onRandomMatchCharacter={() => handleRandomMatch('character')}
                  isAuthenticated={isAuthenticated}
                  isGenerating={isGenerating}
                  isMatching={isMatching}
                  combatantCount={combatants.length}
                />
                <div className="battle-lite-muted-text mt-2 text-xs">
                  提示：浏览在线角色库可选择公开/私有数据卡；随机匹配仅从公开角色库中抽取。
                </div></>,
          localImport: <RosterUploader />,
          roster: <CombatantList onShowDetails={(combatant) => setSelectedCombatant(combatant)} />,
          mode: <BattleModeSwitcher />,
          scenario: <BattleLiteScenarioSection onOpenScenarioModal={handleOpenScenarioDataModal} isAuthenticated={isAuthenticated} />,
          materials: <MaterialPanel onOpenMaterialModal={handleOpenMaterialDataModal} />,
          storyOptions: <BattleLiteStoryOptions />,
          generationMode: <GenerationModeSwitcher showReportFormat />,
          actions: <>                <BattleLiteInheritedContextNotice summary={inheritedSummary} />
                <BattleActions showAdvancedUtilities={false} />
                {error ? (
                  <ErrorMessage
                    message={error}
                    className={`mt-3 rounded-md p-4 text-sm ${
                      error.startsWith('❌')
                        ? 'battle-lite-alert battle-lite-alert--error'
                        : 'battle-lite-alert battle-lite-alert--warning'
                    }`}
                  />
                ) : null}</>,
          community: <ArenaCommunitySection />,
          result: <BattleResult onSaveImage={handleSaveImage} />,
          storySession: <BattleStorySessionPanel onSaveImage={handleSaveImage} />,
          homeLink: <button onClick={() => window.location.assign('/')} className="footer-link">返回首页</button>,
          footer: <Footer />,
        }}
      />

      <ImagePreviewModal
        isOpen={showImageModal}
        imageUrl={savedImageUrl}
        onClose={() => { setShowImageModal(false); setSavedImageUrl(null); }}
        imageAlt="魔法少女战斗报告"
        imageWidth="full"
        hint="📱 长按图片保存到相册"
        closeOnBackdrop={false}
        closeButtonAriaLabel="关闭"
        deferToOtherModals
      />

      <BattleDataModal
        isOpen={showBattleDataModal}
        onClose={() => setShowBattleDataModal(false)}
        onSelectCard={(card, context) => dataModalType === 'character'
          ? handleToggleCombatantDataCard(card, true, context)
          : handleSelectDataCard(card)}
        onToggleCard={
          dataModalType === 'character'
            ? (card, nextSelected, context) => handleToggleCombatantDataCard(card, nextSelected, context)
            : (dataModalType === 'material' ? (card, nextSelected) => void handleToggleMaterialDataCard(card, nextSelected) : undefined)
        }
        selectedType={dataModalType === 'character' ? 'character' : (dataModalType === 'material' ? 'all' : 'scenario')}
        allowedTypes={dataModalType === 'material' ? [...ONLINE_DATA_CARD_TYPES] : undefined}
        titleOverride={dataModalType === 'material' ? '选择素材' : undefined}
        selectionMode={dataModalType === 'scenario' ? 'single' : 'multi'}
        selectedSelectionIds={dataModalType === 'character' ? selectedCharacterSelectionIds : undefined}
        selectedCardIds={
          dataModalType === 'character'
            ? undefined
            : (dataModalType === 'material' ? selectedMaterialDataCardIds : selectedScenarioDataCardIds)
        }
        selectedCountOverride={dataModalType === 'character' ? combatants.length : (dataModalType === 'material' ? materials.length : undefined)}
        maxSelected={dataModalType === 'character' ? characterMaxSelected : (dataModalType === 'material' ? materialMaxSelected : undefined)}
      />

      {selectedCombatant ? (
        <DeferredChunkBoundary onClose={() => setSelectedCombatant(null)}><DataCardDetailsModal
          source={selectedCombatant.isPreset ? { kind: 'preset' } : { kind: 'local', label: '当前输入副本' }}
          isOpen
          onClose={() => setSelectedCombatant(null)}
          metaCardId={selectedCombatant.sourceDataCardId ? selectedCombatant.sourceDataCardId : null}
          card={{
            id: selectedCombatant.sourceDataCardId || selectedCombatant.filename,
            name:
              typeof selectedCombatant.sourceDataCardName === 'string' && selectedCombatant.sourceDataCardName.trim()
                ? selectedCombatant.sourceDataCardName
                : getCombatantDisplayName(selectedCombatant.data),
            description:
              typeof selectedCombatant.sourceDataCardDescription === 'string' &&
              selectedCombatant.sourceDataCardDescription.trim()
                ? selectedCombatant.sourceDataCardDescription
                : (selectedCombatant.isPreset ? '系统预设角色' : '本地角色设定'),
            type: 'character',
            data: JSON.stringify(selectedCombatant.data, null, 2),
            isPublic: Boolean(selectedCombatant.sourceIsPublic),
            usageCount: selectedCombatant.sourceDataCardUsageCount,
            likeCount: selectedCombatant.sourceDataCardLikeCount,
            favoriteCount: selectedCombatant.sourceDataCardFavoriteCount,
            author:
              typeof selectedCombatant.sourceAuthor === 'string' && selectedCombatant.sourceAuthor.trim()
                ? selectedCombatant.sourceAuthor
                : (selectedCombatant.isPreset ? '系统' : '—'),
            createdAt: selectedCombatant.sourceDataCardCreatedAt,
            updatedAt: selectedCombatant.sourceDataCardUpdatedAt,
          }}
        /></DeferredChunkBoundary>
      ) : null}

      {hasOpenedRankingModal ? <DeferredChunkBoundary isOpen={showRankingModal} onClose={() => setShowRankingModal(false)}><ArenaRankingModal isOpen={showRankingModal} onClose={() => setShowRankingModal(false)} /></DeferredChunkBoundary> : null}
    </>
  );
}
