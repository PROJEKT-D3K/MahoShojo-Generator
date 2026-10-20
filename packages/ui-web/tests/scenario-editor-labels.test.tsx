// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScenarioEditor from '../src/character-manager/scenario-editor';
import AdjudicatorEditor from '../src/character-manager/adjudicator-editor';
import { setDataCardFieldValue } from '../src/card-editor';
import type { AdjudicatorEvent } from '@mahoshojo/domain/arena-types';

const scenario = {
  title: '雾港', scenario_type: '调查', description: '夜景',
  _battle_story: { total_chapters: 5, plan_mode: 'suggested' },
  elements: { scene: { time: '夜', place: '港口', features: '浓雾' },
    roles: [{ name: '甲', description: '领航' }, { name: '乙', description: '守望' }],
    events: '找灯塔', atmosphere: '静谧', development: ['出海', '靠岸'] },
  adjudicationEvents: [{ id: 'same-event', description: '发现线索', type: 'binary', probability: 60,
    onSuccess: { event: { id: 'same-event', description: '后续', type: 'binary', probability: 30 } } },
    { id: 'custom-event', description: '天气', type: 'custom', outcomes: [{ id: 'outcome', name: '晴', probability: 100 }] }],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const controls = (scope: ParentNode = container) => [...scope.querySelectorAll<Control>('input,textarea,select')];
const buttons = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].filter(node => node.textContent?.trim() === text);
const fieldset = (name: string) => [...container.querySelectorAll('fieldset')].find(node => node.querySelector('legend')?.textContent === name)!;
const change = (control: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
});
function ScenarioHarness({ onChange = () => {} }: { onChange?: (path: string, value: unknown) => void }) {
  const [data, setData] = useState<Record<string, unknown>>(() => structuredClone(scenario));
  return <ScenarioEditor data={data} onChange={(path, value) => {
    onChange(path, value); setData(previous => setDataCardFieldValue(previous, path.split('.'), value));
  }} />;
}
function EventHarness({ onChange = () => {} }: { onChange?: (events: AdjudicatorEvent[]) => void }) {
  const [events, setEvents] = useState<AdjudicatorEvent[]>([{ id: 'same-event', description: '事件', type: 'binary', probability: 50 }]);
  return <AdjudicatorEditor events={events} onEventsChange={next => { setEvents(next); onChange(next); }} />;
}

describe('shared scenario editor native labels', () => {
  it('names all existing controls and keeps IDs unique and stable across two full scenario instances', () => {
    const render = () => <><ScenarioEditor data={scenario} onChange={() => {}} /><ScenarioEditor data={scenario} onChange={() => {}} /></>;
    act(() => root.render(render()));
    const fields = controls(); expect(fields.length).toBeGreaterThan(50);
    const ids = fields.map(control => control.id);
    expect(ids.every(Boolean)).toBe(true); expect(new Set(ids).size).toBe(fields.length);
    for (const control of fields) {
      expect(control.labels?.length, control.outerHTML).toBeGreaterThan(0);
      for (const label of control.labels!) expect(label.control).toBe(control);
    }
    act(() => root.render(render())); expect(controls().map(control => control.id)).toEqual(ids);
  });

  it('keeps same-card radio groups independent when selecting an actual input in the second editor', () => {
    const first = vi.fn(); const second = vi.fn();
    act(() => root.render(<><section><EventHarness onChange={first} /></section><section><EventHarness onChange={second} /></section></>));
    const groups = [...container.querySelectorAll('section')];
    const firstBinary = groups[0].querySelector<HTMLInputElement>('input[value="binary"]')!;
    const secondCustom = groups[1].querySelector<HTMLInputElement>('input[value="custom"]')!;
    act(() => secondCustom.click());
    expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    expect(firstBinary.checked).toBe(true); expect(secondCustom.checked).toBe(true);
    expect(firstBinary.name).not.toBe(secondCustom.name);
    expect(second.mock.calls[0][0][0]).toMatchObject({ id: 'same-event', type: 'custom', probability: 50 });
  });

  it('routes the second same-card radio label only to its own event', () => {
    const first = vi.fn(); const second = vi.fn();
    act(() => root.render(<><section><EventHarness onChange={first} /></section><section><EventHarness onChange={second} /></section></>));
    const group = container.querySelectorAll('section')[1];
    const label = [...group.querySelectorAll('label')].find(node => node.textContent === '自定义结果')!;
    act(() => label.click());
    expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    expect(group.querySelector<HTMLInputElement>('input[value="custom"]')!.checked).toBe(true);
  });

  it('keeps dynamic NPC and development labels attached after deletion and replacement edits', () => {
    const updated = vi.fn(); act(() => root.render(<ScenarioHarness onChange={updated} />));
    const roles = fieldset('NPC角色');
    act(() => buttons(roles, '删除')[0].click());
    const roleName = roles.querySelector<HTMLInputElement>('input')!;
    expect(roleName.value).toBe('乙'); expect(roleName.labels![0].textContent).toBe('角色名称');
    expect(roleName.labels![0].control).toBe(roleName); change(roleName, '新乙');
    expect(updated).toHaveBeenLastCalledWith('elements.roles', [{ name: '新乙', description: '守望' }]);
    act(() => buttons(roles, '+ 添加NPC角色')[0].click());
    expect(new Set(controls(roles).map(control => control.id)).size).toBe(4);
    const story = fieldset('故事内容');
    act(() => buttons(story, '删除')[0].click());
    const direction = story.querySelector<HTMLInputElement>('input[placeholder="发展方向 1"]')!;
    expect(direction.value).toBe('靠岸'); expect(direction.labels![0].textContent).toBe('发展方向 1');
    expect(direction.labels![0].control).toBe(direction); change(direction, '新方向');
    expect(updated).toHaveBeenLastCalledWith('elements.development', ['新方向']);
    act(() => buttons(story, '+ 添加发展方向')[0].click());
    for (const control of controls()) for (const label of control.labels!) expect(label.control).toBe(control);
  });

  it('preserves chapter enablement and native disabled controls without edits on label activation', () => {
    const updated = vi.fn(); act(() => root.render(<ScenarioHarness onChange={updated} />));
    const plan = fieldset('连续战报章节规划'); const enabled = plan.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => enabled.labels![0].click()); expect(plan.querySelector('select')).toBeNull();
    expect(updated).toHaveBeenLastCalledWith('_battle_story', undefined);
    act(() => enabled.labels![0].click());
    expect(updated).toHaveBeenLastCalledWith('_battle_story', { total_chapters: 5, plan_mode: 'suggested' });
    expect(plan.querySelector('select')!.labels![0].textContent).toBe('规划模式');
    const inert = vi.fn(); act(() => root.render(<fieldset disabled><ScenarioEditor data={scenario} onChange={inert} /></fieldset>));
    for (const control of controls()) {
      expect(control.matches(':disabled')).toBe(true);
      const activated = vi.fn(); control.addEventListener('click', activated);
      act(() => { control.labels![0].click(); control.focus(); });
      expect(activated).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(control);
    }
    expect(inert).not.toHaveBeenCalled();
  });

  it('keeps positional labels bound to the current NPC and direction after a controlled reorder', () => {
    const updated = vi.fn(); act(() => root.render(<ScenarioEditor data={scenario} onChange={updated} />));
    const ids = controls().map(control => control.id);
    const reordered = { ...scenario, elements: { ...scenario.elements,
      roles: [...scenario.elements.roles].reverse(), development: [...scenario.elements.development].reverse() } };
    act(() => root.render(<ScenarioEditor data={reordered} onChange={updated} />));
    expect(controls().map(control => control.id)).toEqual(ids);
    const role = fieldset('NPC角色').querySelector<HTMLInputElement>('input')!;
    expect(role.value).toBe('乙'); expect(role.labels![0].control).toBe(role);
    change(role, '重排后的乙');
    expect(updated).toHaveBeenLastCalledWith('elements.roles', [{ name: '重排后的乙', description: '守望' }, scenario.elements.roles[0]]);
    const direction = container.querySelector<HTMLInputElement>('input[placeholder="发展方向 1"]')!;
    expect(direction.value).toBe('靠岸'); expect(direction.labels![0].textContent).toBe('发展方向 1');
    expect(direction.labels![0].control).toBe(direction); change(direction, '新靠岸');
    expect(updated).toHaveBeenLastCalledWith('elements.development', ['新靠岸', '出海']);
  });
});
