import type { Env, TgMessage } from './types';
import { Store } from './store';
import { Telegram, displayName } from './telegram';
import { chatComplete } from './ai-filter';
import { formatTelegramHtml } from './format';
import { appendSources, decideSearch, renderSearchContext, runSearch, searchSystemPrompt, withSearchContext } from './search';

const GROUP_PROMPT =
  '你是一个 Telegram 群聊里的 AI 助手。只回答被明确 @ 提到的问题。' +
  '回答要自然、简洁、有帮助，适合群聊阅读；不要假装是群管理员，不要处理封禁/管理命令。' +
  '如果问题需要最新信息且提供了搜索结果，请基于搜索结果回答并附来源；不要编造。';

function isGroupChat(msg: TgMessage): boolean {
  return msg.chat.type === 'group' || msg.chat.type === 'supergroup';
}

function stripLeadingAt(username: string): string {
  return username.trim().replace(/^@/, '');
}

async function getBotUsername(env: Env, store: Store, tg: Telegram): Promise<string | null> {
  const configured = stripLeadingAt(env.BOT_USERNAME || '');
  if (configured) return configured.toLowerCase();

  const cached = await store.getBotUsername();
  if (cached) return stripLeadingAt(cached).toLowerCase();

  const me = await tg.getMe();
  if (!me.username) return null;
  await store.setBotUsername(me.username);
  return stripLeadingAt(me.username).toLowerCase();
}

function extractMentionQuestion(msg: TgMessage, botUsername: string): string | null {
  const text = msg.text ?? msg.caption ?? '';
  if (!text) return null;

  const mention = `@${botUsername.toLowerCase()}`;
  const lower = text.toLowerCase();
  if (!lower.includes(mention)) return null;

  return text.replace(new RegExp(`@${escapeRegExp(botUsername)}`, 'gi'), '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n（内容较长，已截断）`;
}

async function sendGroupAiText(tg: Telegram, chatId: number, replyToMessageId: number, text: string, maxChars: number): Promise<void> {
  const clipped = clampText(text, maxChars);
  const html = formatTelegramHtml(clipped);
  const extra = {
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToMessageId },
  };

  if (html.length <= 3900) {
    await tg.sendMessage(chatId, html, extra);
    return;
  }
  await tg.sendLong(chatId, clipped, { reply_parameters: { message_id: replyToMessageId } });
}

export async function handleGroupAiMessage(
  msg: TgMessage,
  env: Env,
  store: Store,
  tg: Telegram,
): Promise<boolean> {
  if (!isGroupChat(msg)) return false;
  if ((env.GROUP_AI_ENABLED ?? 'false') !== 'true') return false;

  const text = msg.text ?? msg.caption ?? '';
  if (!text.includes('@')) return false;

  const botUsername = await getBotUsername(env, store, tg);
  if (!botUsername) return false;

  const question = extractMentionQuestion(msg, botUsername);
  if (question === null) return false;

  if (!question) {
    await tg.sendMessage(msg.chat.id, `请在 @${botUsername} 后面写上问题喵～`, {
      reply_parameters: { message_id: msg.message_id },
    });
    return true;
  }

  const userId = msg.from?.id;
  if (!userId) return true;

  const cooldownSeconds = Number(env.GROUP_USER_COOLDOWN_SECONDS || '30');
  if (!(await store.hitGroupUserCooldown(msg.chat.id, userId, cooldownSeconds))) {
    await tg.sendMessage(msg.chat.id, '你问得有点快啦，稍等一下再 @ 我～', {
      reply_parameters: { message_id: msg.message_id },
    });
    return true;
  }

  const maxConcurrency = Math.max(1, Number(env.GROUP_AI_MAX_CONCURRENCY || '1'));
  const lockTtl = Math.max(15, Number(env.GROUP_AI_LOCK_TTL_SECONDS || '120'));
  const locked = await store.tryAcquireGroupLock(msg.chat.id, maxConcurrency, lockTtl);
  if (!locked) {
    await tg.sendMessage(msg.chat.id, '我正在回答上一条问题，稍后再喊我一下～', {
      reply_parameters: { message_id: msg.message_id },
    });
    return true;
  }

  const maxInputChars = Math.max(100, Number(env.GROUP_AI_MAX_INPUT_CHARS || '1200'));
  const maxOutputChars = Math.max(300, Number(env.GROUP_AI_MAX_OUTPUT_CHARS || '1800'));
  const rounds = Math.max(1, Number(env.GROUP_AI_CONTEXT_ROUNDS || '4'));
  const contextKey = `group:${msg.chat.id}`;
  const userName = displayName(msg.from);
  const prompt = `${userName}: ${clampText(question, maxInputChars)}`;
  const ack = await tg.sendMessage(msg.chat.id, '🤔 我想想喵…', {
    reply_parameters: { message_id: msg.message_id },
  });

  try {
    const history = await store.getContext(contextKey);
    history.push({ role: 'user', content: prompt });
    const model = (await store.getActiveModel()) || env.AI_MODEL;
    const decision = await decideSearch(question, env, model);
    let answer: string;

    if (decision.needSearch) {
      await tg.editMessageText(msg.chat.id, ack.message_id, '🔎 我查一下再回答…').catch(() => {});
      const results = await runSearch(decision.query, env);
      const searchContext = renderSearchContext(decision.query, results);
      const searched = await chatComplete(withSearchContext(history, searchContext), env, searchSystemPrompt(GROUP_PROMPT), model);
      answer = appendSources(searched, results);
    } else {
      answer = await chatComplete(history, env, GROUP_PROMPT, model);
    }

    const finalText = answer && answer.trim() ? answer : 'AI 暂时没有生成内容，请稍后再试。';
    await sendGroupAiText(tg, msg.chat.id, msg.message_id, finalText, maxOutputChars);
    await tg.editMessageText(msg.chat.id, ack.message_id, '✅ 已回答').catch(() => {});
    await store.appendContext(contextKey, { role: 'user', content: prompt }, rounds);
    await store.appendContext(contextKey, { role: 'assistant', content: finalText }, rounds);
  } catch (e) {
    await tg
      .editMessageText(msg.chat.id, ack.message_id, `⚠️ 群聊 AI 出错：${(e as Error).message}`)
      .catch(async () => {
        await tg.sendMessage(msg.chat.id, `⚠️ 群聊 AI 出错：${(e as Error).message}`).catch(() => {});
      });
  } finally {
    await store.releaseGroupLock(msg.chat.id).catch(() => {});
  }

  return true;
}
