import type { Env, TgUpdate, TgMessage } from './types';
import { makeStore, Store } from './store';
import { Telegram, displayName } from './telegram';
import { isAdmin } from './moderation';
import { ensureVerified } from './verify';
import { classifyMessage, shouldIntercept } from './ai-filter';
import { makeRelay } from './relay';
import { handleAdminMessage } from './admin';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') return new Response('ok');

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
      // Process in background; ack Telegram immediately.
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('handleUpdate error', e)));
      return new Response('ok');
    }

    return new Response('twochatbot', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  const store = makeStore(env);
  const tg = new Telegram(env.BOT_TOKEN);

  if (await store.seenUpdate(update.update_id)) return; // idempotency

  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.from || msg.from.is_bot) return;

  // Admin side (private chat with the bot).
  if (isAdmin(env, msg.from.id)) {
    await handleAdminMessage(msg, env, store, tg);
    return;
  }

  await handleUserMessage(msg, env, store, tg);
}

async function handleUserMessage(msg: TgMessage, env: Env, store: Store, tg: Telegram): Promise<void> {
  const userId = msg.from!.id;
  const text = msg.text ?? msg.caption ?? '';

  // Blocklist -> silently drop.
  if (await store.isBlocked(userId)) return;

  // /start
  if (text.trim() === '/start') {
    await tg.sendMessage(userId, env.WELCOME_MESSAGE || '你好。');
  }

  // Load or create profile.
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

  // First-time verification gate.
  if (!profile.verified) {
    const ok = await ensureVerified(profile, text, env, store, tg);
    if (!ok) return; // not verified yet; nothing forwarded
  }

  // Rate limit (5/min).
  if (!(await store.hitRate(userId, 5))) {
    await tg.sendMessage(userId, '⏳ 你发得太快了，请稍后再试。');
    return;
  }

  // AI gatekeeper.
  if (text && (env.FILTER_ENABLED ?? 'true') === 'true') {
    const c = await classifyMessage(text, env);
    if (shouldIntercept(c, env)) {
      const id = `${userId}-${msg.message_id}`;
      await store.saveIntercepted(id, {
        userId,
        text,
        category: c.category,
        reason: c.reason,
        provider: c.provider,
        time: Date.now(),
      });
      await tg.sendMessage(userId, '您的消息已收到。');
      return; // do NOT disturb the admin
    }
    // Keep recent context for ghostwriting.
    await store.appendContext(String(userId), { role: 'user', content: text }, Number(env.AI_CONTEXT_ROUNDS || '6'));
  }

  // Greeter (template, zero AI cost), once per user.
  if (env.AUTO_GREETING && !profile.greeted) {
    await tg.sendMessage(userId, env.AUTO_GREETING);
    profile.greeted = true;
    await store.saveUser(profile);
  }

  // Relay to admin.
  const relay = makeRelay(env, store, tg);
  await relay.deliverToAdmin(msg);
}
