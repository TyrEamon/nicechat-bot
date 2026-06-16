import type { Env, TgUpdate, TgMessage } from './types';
import { makeStore, Store } from './store';
import { Telegram, displayName } from './telegram';
import { isAdmin } from './moderation';
import { ensureVerified } from './verify';
import { classifyMessage, shouldIntercept, chatCompleteStream } from './ai-filter';
import { makeRelay } from './relay';
import { handleAdminMessage } from './admin';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') return new Response('ok');

    if (url.pathname === '/trace') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const t = await env.TG_BOT_KV.get('debug:trace');
      return new Response(t || '(无 trace)', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/lasterror') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const e = await env.TG_BOT_KV.get('debug:lasterror');
      return new Response(e || '(无错误记录)', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/last') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const last = await env.TG_BOT_KV.get('debug:last');
      return new Response(last || '(还没有收到任何 webhook 更新)', { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/webhookinfo') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
      return new Response(await r.text(), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/selftest') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const tg = new Telegram(env.BOT_TOKEN);
      const trace: Record<string, unknown> = {};
      // step 1: send a telegram message to admin
      try {
        const m = await tg.sendMessage(env.ADMIN_UID, '🔧 selftest: 这是来自 Worker 的测试消息');
        trace.sendMessage = { ok: true, message_id: (m as { message_id: number }).message_id };
      } catch (e) {
        trace.sendMessage = { ok: false, error: (e as Error).message };
      }
      // step 2: stream a short AI completion
      const t0 = Date.now();
      try {
        let deltas = 0;
        const out = await chatCompleteStream(
          [{ role: 'user', content: '用一句话自我介绍' }],
          env,
          '你是助理',
          env.AI_MODEL,
          () => { deltas++; },
        );
        trace.stream = { ok: true, ms: Date.now() - t0, deltas, text: out.slice(0, 200) };
      } catch (e) {
        trace.stream = { ok: false, ms: Date.now() - t0, error: (e as Error).message };
      }
      return new Response(JSON.stringify(trace, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/diag') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const out: Record<string, unknown> = {
        version: '2026-06-16T13:26:04.713Z',
        has_BOT_TOKEN: !!env.BOT_TOKEN,
        has_AI_API_KEY: !!env.AI_API_KEY,
        AI_BASE_URL: env.AI_BASE_URL,
        AI_MODEL: env.AI_MODEL,
        AI_PROVIDER: env.AI_PROVIDER,
        ADMIN_UID: env.ADMIN_UID,
      };
      // test relay chat
      try {
        const r = await fetch(`${(env.AI_BASE_URL || '').replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
          body: JSON.stringify({ model: env.AI_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
        });
        out.relay_status = r.status;
        out.relay_body = (await r.text()).slice(0, 300);
      } catch (e) {
        out.relay_error = (e as Error).message;
      }
      // test workers ai
      try {
        const ai = (await env.AI.run(env.CF_AI_MODEL, { messages: [{ role: 'user', content: 'ping' }] })) as { response?: string };
        out.workers_ai = ai.response?.slice(0, 120) ?? '(no response field)';
      } catch (e) {
        out.workers_ai_error = (e as Error).message;
      }
      return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/setcommands') {
      if (url.searchParams.get('secret') !== env.BOT_SECRET) return new Response('forbidden', { status: 403 });
      const tg = new Telegram(env.BOT_TOKEN);
      // Public menu: strangers only see /start
      await tg.setMyCommands([{ command: 'start', description: '开始使用 / 重新验证' }], { type: 'default' });
      // Admin menu: full management commands, only in the admin's private chat
      const adminCommands = [
        { command: 'ai', description: '与AI助理对话；reply转发消息则按意向代笔' },
        { command: 'model', description: '查看/切换模型：list 列表，<名字> 切换，default 恢复' },
        { command: 'to', description: '主动给用户发消息：/to <uid> 内容' },
        { command: 'block', description: '拉黑用户（reply转发消息或带uid）' },
        { command: 'unblock', description: '解封用户（reply转发消息或带uid）' },
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
      // Debug: stash the raw update so /last can show what Telegram sent.
      ctx.waitUntil(env.TG_BOT_KV.put('debug:last', JSON.stringify(update, null, 2), { expirationTtl: 3600 }));
      // Process in background; ack Telegram immediately.
      ctx.waitUntil(
        handleUpdate(update, env).catch((e) =>
          env.TG_BOT_KV.put('debug:lasterror', String((e as Error).stack || e), { expirationTtl: 3600 }),
        ),
      );
      return new Response('ok');
    }

    return new Response('twochatbot', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  const steps: string[] = [];
  const trace = (s: string) => {
    steps.push(`${steps.length}: ${s}`);
    return env.TG_BOT_KV.put('debug:trace', steps.join('\n'), { expirationTtl: 3600 });
  };
  await trace('handleUpdate enter');
  const store = makeStore(env);
  const tg = new Telegram(env.BOT_TOKEN);

  const seen = await store.seenUpdate(update.update_id);
  await trace('seenUpdate=' + seen);
  if (seen) return; // idempotency

  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.from || msg.from.is_bot) { await trace('no msg/from or is_bot, return'); return; }

  await trace('from.id=' + msg.from.id + ' isAdmin=' + isAdmin(env, msg.from.id));

  // Admin side (private chat with the bot).
  if (isAdmin(env, msg.from.id)) {
    try {
      await trace('calling handleAdminMessage, text=' + (msg.text ?? msg.caption ?? ''));
      await handleAdminMessage(msg, env, store, tg);
      await trace('handleAdminMessage done');
    } catch (e) {
      await trace('admin error: ' + (e as Error).message);
      await tg.sendMessage(env.ADMIN_UID, `⚠️ 处理出错：${(e as Error).message}`).catch(() => {});
    }
    return;
  }

  await trace('calling handleUserMessage');
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
    const activeModel = (await store.getActiveModel()) || env.AI_MODEL;
    const c = await classifyMessage(text, env, activeModel);
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
