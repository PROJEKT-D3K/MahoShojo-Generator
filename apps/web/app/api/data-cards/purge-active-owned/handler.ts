import { handleOwnedDataCardDeletion } from '@/lib/data-card-deletion-handler';

export const appRouteHandler = (req: Request): Promise<Response> => handleOwnedDataCardDeletion(req, 'purge-active');
