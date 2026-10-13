import { MagicTeaPartySessionSetupPanel as SharedSetupPanel, type MagicTeaPartySessionSetupPanelProps } from '@mahoshojo/ui-web/magic-tea-party';

export function MagicTeaPartySessionSetupPanel(props: MagicTeaPartySessionSetupPanelProps) {
  return <SharedSetupPanel {...props}
    roleFileAccept=".json,.png"
    roleImportHint="粘贴 / 拖拽导入角色卡（支持 SillyTavern PNG/JSON）"
    rolePickerLabel="浏览在线角色库"
    scenarioPickerLabel="浏览在线情景库"
  />;
}
