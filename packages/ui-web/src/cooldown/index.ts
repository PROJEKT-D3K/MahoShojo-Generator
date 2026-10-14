import { useState, useEffect, useCallback } from 'react';

const COOLDOWN_SYNC_EVENT = 'mahoshojo:cooldown-sync';

export type ProviderCooldownMode = 'system' | 'custom';

type CooldownSnapshot = {
  endTime: number | null;
  remainingTime: number;
};

type CooldownSyncDetail = {
  key: string;
  endTime: number | null;
};

type CooldownStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type SessionCooldown = {
  endTime: number | null;
  pendingWrite: boolean;
};

// 只属于当前文档；写失败不能把冷却丢掉，也不能伪装成已跨重启持久化。
const sessions = new WeakMap<Window, Map<string, SessionCooldown>>();

type ProviderCooldownNoticeInput = {
  currentMode: ProviderCooldownMode;
  currentIsCooldown: boolean;
  otherRemainingTime: number;
};

type UseProviderModeCooldownOptions = {
  baseKey: string;
  currentMode: ProviderCooldownMode;
  systemDurationMs: number;
  customDurationMs: number;
};

export const getOtherProviderCooldownMode = (mode: ProviderCooldownMode): ProviderCooldownMode =>
  mode === 'custom' ? 'system' : 'custom';

export const buildProviderCooldownStorageKey = (baseKey: string, mode: ProviderCooldownMode): string =>
  `${baseKey}:${mode}`;

const getProviderCooldownModeLabel = (mode: ProviderCooldownMode): string =>
  mode === 'custom' ? '自定义通道' : '默认通道';

const getCooldownStorage = (): CooldownStorage | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const storage = globalThis.localStorage;
    if (
      !storage
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function'
    ) {
      return null;
    }

    return storage;
  } catch {
    return null;
  }
};

export const getProviderCooldownNoticeText = ({
  currentMode,
  currentIsCooldown,
  otherRemainingTime,
}: ProviderCooldownNoticeInput): string | null => {
  if (otherRemainingTime <= 0) return null;

  const currentLabel = getProviderCooldownModeLabel(currentMode);
  const otherLabel = getProviderCooldownModeLabel(getOtherProviderCooldownMode(currentMode));

  if (currentIsCooldown) {
    return `${otherLabel}也在冷却中 (${otherRemainingTime}s)。`;
  }

  return `${otherLabel}冷却中 (${otherRemainingTime}s)，当前${currentLabel}仍可使用。`;
};

const parseStoredEndTime = (item: string | null): number | null => {
  if (!item) return null;
  const parsed = Number.parseInt(item, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const isLocalStorageEvent = (event: StorageEvent): boolean =>
  event.storageArea == null || event.storageArea === getCooldownStorage();

const getCooldownSession = (): Map<string, SessionCooldown> | null => {
  if (typeof window === 'undefined') return null;
  const existing = sessions.get(window);
  if (existing) return existing;

  const session = new Map<string, SessionCooldown>();
  sessions.set(window, session);
  // 路由卸载后仍接收其它页面的更新，避免失败写的本页兜底遮住后来的 clear/延长。
  window.addEventListener?.('storage', (event: StorageEvent) => {
    if (!isLocalStorageEvent(event)) return;
    if (event.key === null) {
      session.clear();
    } else if (session.has(event.key)) {
      session.set(event.key, { endTime: parseStoredEndTime(event.newValue), pendingWrite: false });
    }
  });
  return session;
};

const getLocalStorageItem = (key: string): SessionCooldown & { fromStorage: boolean } => {
  const session = getCooldownSession();
  const cached = session?.get(key);
  // 写入失败时存储里可能仍是旧值，不能用旧值覆盖已开始的当前会话冷却。
  if (cached?.pendingWrite) return { ...cached, fromStorage: false };
  const storage = getCooldownStorage();
  if (storage) {
    try {
      const endTime = parseStoredEndTime(storage.getItem(key));
      session?.set(key, { endTime, pendingWrite: false });
      return { endTime, pendingWrite: false, fromStorage: true };
    } catch {
      // 存储读取受限时只保留本页已知快照，不猜测其它页面或重启后的状态。
    }
  }
  return { endTime: cached?.endTime ?? null, pendingWrite: false, fromStorage: false };
};

const setLocalStorageItem = (key: string, value: number | null) => {
  const session = getCooldownSession();
  session?.set(key, { endTime: value, pendingWrite: true });
  const storage = getCooldownStorage();
  if (!storage) return;
  try {
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value.toString());
    }
    session?.set(key, { endTime: value, pendingWrite: false });
  } catch {
    // QuotaExceededError / SecurityError 只影响持久化，不能改判已完成的业务请求。
  }
};

const emitCooldownSync = (key: string, endTime: number | null) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }

  try {
    const event = new CustomEvent<CooldownSyncDetail>(COOLDOWN_SYNC_EVENT, {
      detail: { key, endTime },
    });
    window.dispatchEvent(event);
  } catch {
    // 忽略极端环境下不支持 CustomEvent 的情况
  }
};

export const readCooldownSnapshot = (key: string): CooldownSnapshot => {
  const { endTime, fromStorage, pendingWrite } = getLocalStorageItem(key);
  if (!endTime) {
    return { endTime: null, remainingTime: 0 };
  }

  const remaining = endTime - Date.now();
  if (remaining <= 0) {
    if (fromStorage) {
      setLocalStorageItem(key, null);
    } else {
      // 读失败时不能删除未核实的持久值，它可能已经被另一页面延长。
      getCooldownSession()?.set(key, { endTime: null, pendingWrite });
    }
    return { endTime: null, remainingTime: 0 };
  }

  return {
    endTime,
    remainingTime: Math.ceil(remaining / 1000),
  };
};

export const writeCooldownSnapshot = (key: string, endTime: number | null): CooldownSnapshot => {
  setLocalStorageItem(key, endTime);
  emitCooldownSync(key, endTime);
  return readCooldownSnapshot(key);
};

export const subscribeCooldownKey = (key: string, onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }

  getCooldownSession();
  const notify = () => {
    try {
      onChange();
    } catch {
      // 只隔离订阅通知；业务执行、请求失败及取消仍由调用方处理。
    }
  };

  const handleSync = (event: Event) => {
    const detail = (event as CustomEvent<CooldownSyncDetail>).detail;
    if (detail?.key !== key) return;
    notify();
  };

  const handleStorage = (event: StorageEvent) => {
    if (!isLocalStorageEvent(event)) return;
    if (event.key !== null && event.key !== key) return;
    notify();
  };

  window.addEventListener(COOLDOWN_SYNC_EVENT, handleSync as EventListener);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(COOLDOWN_SYNC_EVENT, handleSync as EventListener);
    window.removeEventListener('storage', handleStorage);
  };
};

export const useCooldown = (key: string, duration: number) => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  const [cooldownEndTime, setCooldownEndTime] = useState<number | null>(() =>
    isDevelopment ? null : readCooldownSnapshot(key).endTime
  );
  const [remainingTime, setRemainingTime] = useState<number>(() =>
    isDevelopment ? 0 : readCooldownSnapshot(key).remainingTime
  );

  const syncFromStorage = useCallback(() => {
    if (isDevelopment) {
      setCooldownEndTime(null);
      setRemainingTime(0);
      return;
    }

    const snapshot = readCooldownSnapshot(key);
    setCooldownEndTime(snapshot.endTime);
    setRemainingTime(snapshot.remainingTime);
  }, [isDevelopment, key]);

  useEffect(() => {
    syncFromStorage();
  }, [syncFromStorage]);

  useEffect(() => {
    if (isDevelopment) return;
    return subscribeCooldownKey(key, syncFromStorage);
  }, [isDevelopment, key, syncFromStorage]);

  useEffect(() => {
    if (isDevelopment || !cooldownEndTime) return;

    const calculateRemainingTime = () => {
      // 先读最新截止时间，旧 interval 不能清除其它实例/页面刚延长的冷却。
      const snapshot = readCooldownSnapshot(key);
      setCooldownEndTime(snapshot.endTime);
      setRemainingTime(snapshot.remainingTime);
      if (!snapshot.endTime) emitCooldownSync(key, null);
    };

    calculateRemainingTime();
    const interval = setInterval(calculateRemainingTime, 1000);

    return () => clearInterval(interval);
  }, [cooldownEndTime, isDevelopment, key]);

  const startCooldown = useCallback((overrideDuration?: number) => {
    if (isDevelopment) return;

    const rawDuration = typeof overrideDuration === 'number' ? overrideDuration : duration;
    const effectiveDuration = Math.max(0, Math.floor(rawDuration));
    const endTime = effectiveDuration > 0 ? Date.now() + effectiveDuration : null;
    const snapshot = writeCooldownSnapshot(key, endTime);
    setCooldownEndTime(snapshot.endTime);
    setRemainingTime(snapshot.remainingTime);
  }, [duration, isDevelopment, key]);

  const isCooldown = !isDevelopment && remainingTime > 0;

  return { isCooldown, startCooldown, remainingTime };
};

export const useProviderModeCooldown = ({
  baseKey,
  currentMode,
  systemDurationMs,
  customDurationMs,
}: UseProviderModeCooldownOptions) => {
  const systemCooldown = useCooldown(
    buildProviderCooldownStorageKey(baseKey, 'system'),
    systemDurationMs,
  );
  const customCooldown = useCooldown(
    buildProviderCooldownStorageKey(baseKey, 'custom'),
    customDurationMs,
  );

  const currentCooldown = currentMode === 'custom' ? customCooldown : systemCooldown;
  const otherCooldown = currentMode === 'custom' ? systemCooldown : customCooldown;

  return {
    ...currentCooldown,
    otherMode: getOtherProviderCooldownMode(currentMode),
    otherIsCooldown: otherCooldown.isCooldown,
    otherRemainingTime: otherCooldown.remainingTime,
  };
};
