import type { Env, TgUpdate, TgMessage } from './types';
import { makeStore, Store } from './store';
import { Telegram, displayName } from './telegram';
import { isAdmin } from './moderation';
import { ensureVerified } from './verify';
import { classifyMessage, shouldIntercept } from './ai-filter';
import { makeRelay } from './relay';
import { handleAdminMessage } from './admin';
import { handleDraftCallback } from './assistant';
import { handleGroupAiMessage } from './group-ai';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') return new Response('ok');


    if (url.pathname === '/setcommands') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const tg = new Telegram(env.BOT_TOKEN);
      await tg.setMyCommands([{ command: 'start', description: '开始使用 / 重新验证' }], { type: 'default' });
      const adminCommands = [
        { command: 'ai', description: '与AI助理对话；reply转发消息则按意向代笔' },
        { command: 'model', description: '查看/切换模型：list 列表，<名字> 切换，default 恢复' },
        { command: 'aimode', description: 'AI 模式开关：on 开启普通消息直聊，off 退出' },
        { command: 'to', description: '主动给用户发消息：/to <uid> 内容' },
        { command: 'intercepts', description: '查看最近拦截记录' },
        { command: 'ban', description: '封禁用户（reply转发消息或带uid）' },
        { command: 'unban', description: '解封用户（reply转发消息或带uid）' },
        { command: 'forgive', description: '清空用户误伤/违规计数（reply或带uid）' },
      ];
      if (env.ADMIN_UID) {
        await tg.setMyCommands(adminCommands, { type: 'chat', chat_id: Number(env.ADMIN_UID) });
      }
      return new Response('✅ commands set (public: start; admin: full menu)');
    }

    if (url.pathname === '/registerWebhook') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const tg = new Telegram(env.BOT_TOKEN);
      const hookUrl = `${url.origin}/webhook`;
      await tg.setWebhook(hookUrl, env.BOT_SECRET);
      return new Response(`✅ webhook set to ${hookUrl}`);
    }

    if (url.pathname === '/unregisterWebhook') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      await new Telegram(env.BOT_TOKEN).deleteWebhook();
      return new Response('✅ webhook deleted');
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.BOT_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = (await request.json()) as TgUpdate;
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('handleUpdate error', e)));
      return new Response('ok');
    }

    return new Response('nicechat-bot', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  const store = makeStore(env);
  const tg = new Telegram(env.BOT_TOKEN);

  if (await store.seenUpdate(update.update_id)) return;

  if (update.callback_query) {
    const callback = update.callback_query;
    if (!isAdmin(env, callback.from.id)) {
      await tg.answerCallbackQuery(callback.id, '无权限');
      return;
    }
    const data = callback.data ?? '';
    const messageId = callback.message?.message_id;
    const match = data.match(/^draft:(send|regen|manual):(.+)$/);
    if (match && messageId) {
      await tg.answerCallbackQuery(callback.id, '处理中…');
      await handleDraftCallback(match[1], match[2], messageId, env, store, tg);
      return;
    }
    await tg.answerCallbackQuery(callback.id, '未知操作');
    return;
  }

  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.from || msg.from.is_bot) return;

  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    if (await handleGroupAiMessage(msg, env, store, tg)) return;
    return;
  }

  if (msg.chat.type !== 'private') return;

  if (isAdmin(env, msg.from.id)) {
    try {
      await handleAdminMessage(msg, env, store, tg);
    } catch (e) {
      await tg.sendMessage(env.ADMIN_UID, `⚠️ 处理出错：${(e as Error).message}`).catch(() => {});
    }
    return;
  }

  await handleUserMessage(msg, env, store, tg);
}

async function handleUserMessage(msg: TgMessage, env: Env, store: Store, tg: Telegram): Promise<void> {
  const userId = msg.from!.id;
  const text = msg.text ?? msg.caption ?? '';

  if (await store.isBlocked(userId)) {
    await handleBlockedUserMessage(userId, text, env, store, tg);
    return;
  }

  let profile = await store.getUser(userId);
  if (!profile) {
    profile = {
      id: userId,
      name: displayName(msg.from),
      username: msg.from!.username,
      verified: false,
      greeted: false,
      createdAt: Date.now(),
    };
    await store.saveUser(profile);
  }

  if (text.trim() === '/start') {
    await tg.sendMessage(userId, env.WELCOME_MESSAGE || '你好。');
    await store.resetVerification(userId);
    profile.verified = false;
  }

  if (!profile.verified) {
    const ok = await ensureVerified(profile, text, env, store, tg);
    if (!ok) return;
  }

  if (!(await store.hitRate(userId, 5))) {
    await tg.sendMessage(userId, '⏳ 你发得太快了，请稍后再试。');
    return;
  }

  if (text && (env.FILTER_ENABLED ?? 'true') === 'true') {
    const activeModel = (await store.getActiveModel()) || env.AI_MODEL;
    const c = await classifyMessage(text, env, activeModel);
    if (shouldIntercept(c, env, text)) {
      const violationCount = await store.incrementViolation(userId);
      const id = `${userId}-${msg.message_id}`;
      await store.saveIntercepted({
        id,
        userId,
        text,
        category: c.category,
        confidence: c.confidence,
        reason: c.reason,
        provider: c.provider,
        time: Date.now(),
        violationCount,
      });
      const threshold = Number(env.AUTO_BAN_THRESHOLD || '3');
      if (threshold > 0 && violationCount >= threshold) {
        await store.block(userId, `auto ban after ${violationCount} intercepted messages`, 'auto');
        await tg.sendMessage(userId, env.BAN_MESSAGE || '你已被系统封禁。如需申诉，请发送 /appeal <申诉说明>。');
        await tg
          .sendMessage(env.ADMIN_UID, `🚫 自动封禁 uid:${userId}\n违规次数：${violationCount}\n最近原因：${c.reason}\n内容：${text.slice(0, 500)}`)
          .catch(() => {});
      } else {
        await tg.sendMessage(userId, '您的消息已收到。');
      }
      return;
    }
    await store.appendContext(String(userId), { role: 'user', content: text }, Number(env.AI_CONTEXT_ROUNDS || '6'));
  }

  if (env.AUTO_GREETING && !profile.greeted) {
    await tg.sendMessage(userId, env.AUTO_GREETING);
    profile.greeted = true;
    await store.saveUser(profile);
  }

  const relay = makeRelay(env, store, tg);
  await relay.deliverToAdmin(msg);
}

async function handleBlockedUserMessage(
  userId: number,
  text: string,
  env: Env,
  store: Store,
  tg: Telegram,
): Promise<void> {
  if (text.trim().startsWith('/appeal')) {
    const appealText = text.replace(/^\/appeal\s*/, '').trim();
    const maxAttempts = Number(env.APPEAL_MAX_ATTEMPTS || '2');
    const attempts = await store.incrementAppeal(userId);
    if (attempts > maxAttempts) {
      await tg.sendMessage(userId, '申诉次数已用完，请等待管理员处理。');
      return;
    }
    await tg.sendMessage(userId, env.APPEAL_MESSAGE || '申诉已收到，管理员会视情况处理。');
    await tg
      .sendMessage(
        env.ADMIN_UID,
        `📩 封禁申诉 uid:${userId}\n次数：${attempts}/${maxAttempts}\n内容：${appealText || '(未填写说明)'}\n\n处理：/unban ${userId}`,
      )
      .catch(() => {});
    return;
  }

  await tg.sendMessage(userId, env.BAN_MESSAGE || '你已被系统封禁。如需申诉，请发送 /appeal <申诉说明>。');
}
