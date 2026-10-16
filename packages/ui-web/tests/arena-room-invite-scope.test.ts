import { expect, it, vi } from 'vitest';
import { createRoomInviteScope } from '../src/arena-room/room-invite-scope';

it('逐次退休不依赖 React 渲染；普通 revision 通知保持原 token，退订释放源监听', () => {
  let scope: string | null = 'room-A';
  const listeners = new Set<() => void>();
  const emit = (next: string | null) => { scope = next; listeners.forEach(listener => listener()); };
  const store = createRoomInviteScope({ readScope: () => scope, subscribe: listener => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } });
  const listener = vi.fn(), stop = store.subscribe(listener);
  const initial = store.getSnapshot(); emit('room-A'); expect(store.getSnapshot()).toBe(initial);
  emit(null); emit('room-A'); expect(store.getSnapshot()).not.toBe(initial);
  const replacement = store.getSnapshot(); emit('room-A'); expect(store.getSnapshot()).toBe(replacement);
  expect(listener).toHaveBeenCalledTimes(4); stop(); expect(listeners.size).toBe(0);
});
