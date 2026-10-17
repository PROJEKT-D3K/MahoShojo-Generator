import type { QuestionnaireSelection } from '@mahoshojo/domain/questionnaire-selection';
import { BasicCardDetailsModal, type CardDetailsSource } from '@mahoshojo/ui-web/card-details';
import { DesktopCardDetailsMarkdown } from '../card-details/card-details-modal';

const describeSelectionSource = (selection: QuestionnaireSelection): CardDetailsSource => {
  // 选择集只保留缓存来源标识，没有最近读取时间，不为展示补查线上或猜测时间。
  if (selection.selectionId?.startsWith('cache:')) return { kind: 'cache', lastSuccessAt: null };
  if (selection.source === 'preset') return { kind: 'preset' };
  return {
    kind: 'local',
    label: '当前问卷副本',
    provenance: selection.source === 'database'
      ? '选自云端数据卡；未重新查询线上状态'
      : '本地上传/本地库；本机未验证签名',
  };
};

/** 只读当前选择，不以追溯 ID、旧许可或缓存副本重新取得云端权限。 */
export function DesktopQuestionnaireDetailsModal({ selection, onClose }: {
  selection: QuestionnaireSelection | null;
  onClose: () => void;
}) {
  if (!selection) return null;
  const { questionnaire } = selection;
  // 此处只能保留选择集已有的完整归一化定义，不能声称是上传文件的原始字节。
  const data = JSON.stringify(questionnaire, null, 2);
  const id = selection.selectionId ?? `questionnaire:${selection.source}:${questionnaire.id}`;
  const nativeDeclaration = questionnaire.nativeAllowed === true ? '允许' : questionnaire.nativeAllowed === false ? '不允许' : '未声明';
  return <BasicCardDetailsModal
    key={id}
    isOpen
    onClose={onClose}
    card={{ id, name: questionnaire.title, description: questionnaire.description ?? '', type: 'questionnaire', data, isPublic: false, author: selection.dataCardAuthor }}
    source={describeSelectionSource(selection)}
    renderMarkdown={(content) => <DesktopCardDetailsMarkdown content={content} />}
    beforeOverview={<p className="text-sm text-gray-600">当前问卷副本，展示本页已选择的问卷定义，不会重新读取或修改来源数据卡；未查询线上指标。</p>}
    metadata={<section className="space-y-2 text-sm text-gray-600">
      <p>题目 {questionnaire.questions.length} 道{questionnaire.loreMarkdown?.trim() ? ` · 含设定${selection.useLore === false ? '（当前未启用）' : ''}` : ''}</p>
      <p>原生签名许可声明：{nativeDeclaration}；不代表当前服务器资格，本机未验证签名，不限制本地生成。</p>
      <details>
        <summary className="cursor-pointer">当前问卷 JSON（已归一化）</summary>
        <p className="mt-2 text-xs">保留当前选择中的完整定义，不是上传文件的原始字节；字段预览的截断不会影响这里的内容。</p>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">{data}</pre>
      </details>
    </section>}
  />;
}
