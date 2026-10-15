import { getUserRecycleBinCards, restoreDataCard } from '@/lib/database/data-cards';
import { requireAuthUser } from '@/lib/auth/server';

async function handler(req: Request): Promise<Response> {
  const auth = await requireAuthUser(req);
  if ('response' in auth) return auth.response;

  const userId = auth.user.id;

  try {
    switch (req.method) {
      case 'GET': {
        const cards = await getUserRecycleBinCards(userId);
        return new Response(JSON.stringify({ success: true, cards }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      case 'PATCH': {
        const { id } = await req.json();

        if (typeof id !== 'string' || !id.trim()) {
          return new Response(JSON.stringify({ error: '缺少数据卡ID' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const result = await restoreDataCard(id, userId);
        if (result.status === 'not_found') {
          return new Response(JSON.stringify({ error: '数据卡不存在或无法恢复' }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (result.status !== 'restored') {
          return new Response(JSON.stringify({ error: result.status === 'quota_exceeded'
            ? '恢复该数据卡所需槽位超出当前容量，请释放足够槽位后再尝试恢复'
            : '数据卡状态已变化，请刷新后重试' }), {
            status: 409, headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, message: '数据卡已恢复' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      case 'DELETE': {
        return new Response(JSON.stringify({ error: 'CONFIRMATION_REQUIRED', code: 'CONFIRMATION_REQUIRED' }), {
          status: 409, headers: { 'Content-Type': 'application/json' },
        });
      }
      default:
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' }
        });
    }
  } catch (error) {
    console.error('处理回收站请求失败:', error);
    return new Response(JSON.stringify({ error: '服务器内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export const appRouteHandler = handler;
export default appRouteHandler;
