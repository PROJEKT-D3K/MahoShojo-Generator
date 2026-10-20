import React, { useId } from 'react';

import AdjudicatorEditor from './adjudicator-editor';
import ScenarioBattleStoryPlanEditor from './scenario-battle-story-plan-editor';

export interface ScenarioEditorProps {
  data: any;
  onChange: (path: string, value: any) => void;
}

export default function ScenarioEditor({ data, onChange }: ScenarioEditorProps) {
  const controlId = useId();
  const handleFieldChange = (path: string, value: any) => {
    onChange(path, value);
  };

  const handleArrayChange = (path: string, index: number, value: string) => {
    const currentArray = getNestedValue(data, path) || [];
    const newArray = [...currentArray];
    newArray[index] = value;
    onChange(path, newArray);
  };

  const addArrayItem = (path: string) => {
    const currentArray = getNestedValue(data, path) || [];
    onChange(path, [...currentArray, '']);
  };

  const removeArrayItem = (path: string, index: number) => {
    const currentArray = getNestedValue(data, path) || [];
    const newArray = currentArray.filter((_: any, i: number) => i !== index);
    onChange(path, newArray);
  };

  const addRole = () => {
    const currentRoles = data.elements?.roles || [];
    onChange('elements.roles', [...currentRoles, { name: '', description: '' }]);
  };

  const removeRole = (index: number) => {
    const currentRoles = data.elements?.roles || [];
    const newRoles = currentRoles.filter((_: any, i: number) => i !== index);
    onChange('elements.roles', newRoles);
  };

  const handleRoleChange = (index: number, field: 'name' | 'description', value: string) => {
    const currentRoles = data.elements?.roles || [];
    const newRoles = [...currentRoles];
    newRoles[index] = { ...newRoles[index], [field]: value };
    onChange('elements.roles', newRoles);
  };

  // 辅助函数：获取嵌套对象的值
  const getNestedValue = (obj: any, path: string) => {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  };

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* 基本信息 */}
      <div className="space-y-4">
        <div>
          <label htmlFor={`${controlId}-title`} className="input-label">情景标题</label>
          <input
            id={`${controlId}-title`}
            type="text"
            value={data.title || ''}
            onChange={(e) => handleFieldChange('title', e.target.value)}
            className="input-field"
            placeholder="请输入情景标题"
          />
        </div>

        <div>
          <label htmlFor={`${controlId}-type`} className="input-label">情景类型</label>
          <input
            id={`${controlId}-type`}
            type="text"
            value={data.scenario_type || ''}
            onChange={(e) => handleFieldChange('scenario_type', e.target.value)}
            className="input-field"
            placeholder="例如：日常、互动、考试、竞技比赛、调查、采访等"
          />
        </div>

        <div>
          <label htmlFor={`${controlId}-description`} className="input-label">简短描述</label>
          <textarea
            id={`${controlId}-description`}
            value={data.description || ''}
            onChange={(e) => handleFieldChange('description', e.target.value)}
            className="input-field"
            rows={3}
            placeholder="请输入情景的简短描述"
          />
        </div>
      </div>

      <ScenarioBattleStoryPlanEditor data={data} onChange={onChange} />

      {/* 场景设置 */}
      <fieldset className="border border-gray-300 p-4 rounded-lg">
        <legend className="text-sm font-semibold px-2 text-gray-600">场景设置</legend>
        <div className="space-y-4">
          <div>
            <label htmlFor={`${controlId}-time`} className="input-label">时间</label>
            <input
              id={`${controlId}-time`}
              type="text"
              value={data.elements?.scene?.time || ''}
              onChange={(e) => handleFieldChange('elements.scene.time', e.target.value)}
              className="input-field"
              placeholder="故事发生的时间"
            />
          </div>

          <div>
            <label htmlFor={`${controlId}-place`} className="input-label">地点</label>
            <input
              id={`${controlId}-place`}
              type="text"
              value={data.elements?.scene?.place || ''}
              onChange={(e) => handleFieldChange('elements.scene.place', e.target.value)}
              className="input-field"
              placeholder="故事发生的地点"
            />
          </div>

          <div>
            <label htmlFor={`${controlId}-features`} className="input-label">环境特征</label>
            <textarea
              id={`${controlId}-features`}
              value={data.elements?.scene?.features || ''}
              onChange={(e) => handleFieldChange('elements.scene.features', e.target.value)}
              className="input-field"
              rows={3}
              placeholder="环境特征和陈设等"
            />
          </div>
        </div>
      </fieldset>

      {/* NPC角色 */}
      <fieldset className="border border-gray-300 p-4 rounded-lg">
        <legend className="text-sm font-semibold px-2 text-gray-600">NPC角色</legend>
        <div className="space-y-4">
          {(data.elements?.roles || []).map((role: any, index: number) => (
            <div key={index} className="bg-gray-50 p-3 rounded border">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-gray-700">角色 {index + 1}</span>
                <button
                  onClick={() => removeRole(index)}
                  className="text-red-500 hover:text-red-700 text-sm"
                >
                  删除
                </button>
              </div>
              <div className="space-y-2">
                <div>
                  <label htmlFor={`${controlId}-role-${index}-name`} className="input-label text-xs">角色名称</label>
                  <input
                    id={`${controlId}-role-${index}-name`}
                    type="text"
                    value={role.name || ''}
                    onChange={(e) => handleRoleChange(index, 'name', e.target.value)}
                    className="input-field"
                    placeholder="角色名称或身份"
                  />
                </div>
                <div>
                  <label htmlFor={`${controlId}-role-${index}-description`} className="input-label text-xs">角色描述</label>
                  <textarea
                    id={`${controlId}-role-${index}-description`}
                    value={role.description || ''}
                    onChange={(e) => handleRoleChange(index, 'description', e.target.value)}
                    className="input-field"
                    rows={2}
                    placeholder="该角色的设定、目标或行为准则"
                  />
                </div>
              </div>
            </div>
          ))}
          <button
            onClick={addRole}
            className="w-full py-2 px-4 border border-dashed border-gray-300 rounded text-gray-600 hover:bg-gray-50"
          >
            + 添加NPC角色
          </button>
        </div>
      </fieldset>

      {/* 故事内容 */}
      <fieldset className="border border-gray-300 p-4 rounded-lg">
        <legend className="text-sm font-semibold px-2 text-gray-600">故事内容</legend>
        <div className="space-y-4">
          <div>
            <label htmlFor={`${controlId}-events`} className="input-label">核心事件</label>
            <textarea
              id={`${controlId}-events`}
              value={data.elements?.events || ''}
              onChange={(e) => handleFieldChange('elements.events', e.target.value)}
              className="input-field"
              rows={4}
              placeholder="角色需要做什么？会怎么互动？有什么冲突？"
            />
          </div>

          <div>
            <label htmlFor={`${controlId}-atmosphere`} className="input-label">氛围</label>
            <input
              id={`${controlId}-atmosphere`}
              type="text"
              value={data.elements?.atmosphere || ''}
              onChange={(e) => handleFieldChange('elements.atmosphere', e.target.value)}
              className="input-field"
              placeholder="故事的情感基调和氛围"
            />
          </div>

          <div>
            <span className="input-label">可能的发展方向</span>
            {(data.elements?.development || []).map((item: string, index: number) => (
              <div key={index} className="flex gap-2 mb-2">
                <label htmlFor={`${controlId}-development-${index}`} className="sr-only">发展方向 {index + 1}</label>
                <input
                  id={`${controlId}-development-${index}`}
                  type="text"
                  value={item}
                  onChange={(e) => handleArrayChange('elements.development', index, e.target.value)}
                  className="input-field flex-1"
                  placeholder={`发展方向 ${index + 1}`}
                />
                <button
                  onClick={() => removeArrayItem('elements.development', index)}
                  className="px-3 py-1 text-red-500 hover:text-red-700"
                >
                  删除
                </button>
              </div>
            ))}
            <button
              onClick={() => addArrayItem('elements.development')}
              className="w-full py-2 px-4 border border-dashed border-gray-300 rounded text-gray-600 hover:bg-gray-50"
            >
              + 添加发展方向
            </button>
          </div>
        </div>
      </fieldset>

      {/* 内嵌随机事件 */}
      <fieldset className="border border-gray-300 p-4 rounded-lg">
        <legend className="text-sm font-semibold px-2 text-gray-600">🎲 内嵌随机事件</legend>
        <p className="text-xs text-gray-500 mb-2">在情景中预置随机事件，竞技场加载该情景时会自动加入判定链。</p>
        <AdjudicatorEditor
          events={data.adjudicationEvents || []}
          onEventsChange={(events) => handleFieldChange('adjudicationEvents', events)}
        />
      </fieldset>
    </div>
  );
}
