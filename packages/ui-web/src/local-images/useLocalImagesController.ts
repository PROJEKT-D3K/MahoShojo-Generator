import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createLocalImagesController, type LocalImagesHost } from './controller';

/** host 必须保持稳定。Desktop 由维护锁安排首次读取，因此传 autoLoad=false。 */
export function useLocalImagesController(host: LocalImagesHost, autoLoad = true) {
  const controller = useMemo(() => createLocalImagesController(host), [host]);
  const model = useSyncExternalStore(controller.subscribe, () => controller.model, () => controller.model);
  useEffect(() => {
    if (autoLoad) controller.actions.reload();
    return () => controller.dispose();
  }, [controller, autoLoad]);
  return { controller, model };
}
