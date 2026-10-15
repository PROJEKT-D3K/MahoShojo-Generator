import { handleOwnedRecycleRead } from '../handler';

export async function appRouteHandler(req: Request): Promise<Response> {
  return handleOwnedRecycleRead(req, true);
}
