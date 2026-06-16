import type { Env } from './types';
import { GhostDraft, Store } from './store';
import { Telegram } from './telegram';
import { chatComplete } from './ai-filter';
import { formatTelegramHtml } from './format';

const ASSISTANT_PROMPT =
  '你是机器人主人的私人助理，简洁、专业地协助主人处理日常事务与问题。' +
  '回复适合 Telegram 阅读，尽量少用 Markdown 标记；需要强调时保持克制。';
const GHOST_PROMPT =
  '你在替机器人的主人回复一位陌生用户。请根据主人给出的“意向”和此前的会话上下文，' +
  '生成一条得体、简洁、礼貌的回复，直接输出回复正文，不要解释。' +
  '回复适合 Telegram 阅读，尽量少用 Markdown 标记；需要强调时保持克制。';

function makeDraftId(userId: number): string {
  return `${userId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function draftButtons(id: string) {
  return {
    inline_keyboard: [
      [
        { text: '✅ 确认回复', callback_data: `draft:send:${id}` },
        { text: '🔄 重新生成', callback_data: `draft:regen:${id}` },
      ],
      [{ text: '✍️ 自行回复', callback_data: `draft:manual:${id}` }],
    ],
  };
}

function draftText(draft: GhostDraft): string {
  return `📝 代笔草稿（回复 uid:${draft.userId}）：\n\n${formatTelegramHtml(draft.draft)}`;
}

async function sendAiText(tg: Telegram, chatId: number | string, text: string): Promise<void> {
  const html = formatTelegramHtml(text);
  if (html.length <= 3900) {
    await tg.sendMessage(chatId, html, { parse_mode: 'HTML' });
    return;
  }
  await tg.sendLong(chatId, text);
}

async function generateDraft(userId: number, intent: string, env: Env, store: Store): Promise<string> {
  const ctx = await store.getContext(String(userId));
  const messages = [...ctx, { role: 'user' as const, content: `主人的回复意向：${intent}` }];
  const model = (await store.getActiveModel()) || env.AI_MODEL;
  const draft = await chatComplete(messages, env, GHOST_PROMPT, model);
  return draft && draft.trim() ? draft : '(AI 返回了空草稿，可能超时或模型无输出)';
}

// /ai <question>  (no reply): chat with the personal assistant.
export async function handleAssistant(
  question: string,
  env: Env,
  store: Store,
  tg: Telegram,
): Promise<void> {
  const adminId = env.ADMIN_UID;
  const rounds = Number(env.AI_CONTEXT_ROUNDS || '6');
  const ack = await tg.sendMessage(adminId, '🤔 思考中…');

  try {
    const history = await store.getContext('admin');
    history.push({ role: 'user', content: question });
    const model = (await store.getActiveModel()) || env.AI_MODEL;
    const answer = await chatComplete(history, env, ASSISTANT_PROMPT, model);
    const finalText = answer && answer.trim() ? answer : '(AI 返回了空内容，可能超时或模型无输出)';

    await sendAiText(tg, adminId, finalText);
    await tg.editMessageText(adminId, ack.message_id, '✅ 已生成').catch(() => {});
    await store.appendContext('admin', { role: 'user', content: question }, rounds);
    await store.appendContext('admin', { role: 'assistant', content: answer }, rounds);
  } catch (e) {
    await tg
      .editMessageText(adminId, ack.message_id, `⚠️ 助理出错：${(e as Error).message}`)
      .catch(async () => {
        await tg.sendMessage(adminId, `⚠️ 助理出错：${(e as Error).message}`).catch(() => {});
      });
  }
}

// /ai <intent> while replying to a forwarded message: ghostwrite a reply for the user.
export async function handleGhostwrite(
  userId: number,
  intent: string,
  env: Env,
  store: Store,
  tg: Telegram,
): Promise<void> {
  const adminId = env.ADMIN_UID;
  const ack = await tg.sendMessage(adminId, '✍️ 代笔中…');

  try {
    const draft: GhostDraft = {
      id: makeDraftId(userId),
      userId,
      intent,
      draft: await generateDraft(userId, intent, env, store),
      createdAt: Date.now(),
    };
    await store.saveGhostDraft(draft);
    await tg.editMessageText(adminId, ack.message_id, draftText(draft), {
      parse_mode: 'HTML',
      reply_markup: draftButtons(draft.id),
    });
  } catch (e) {
    await tg
      .editMessageText(adminId, ack.message_id, `⚠️ 代笔出错：${(e as Error).message}`)
      .catch(async () => {
        await tg.sendMessage(adminId, `⚠️ 代笔出错：${(e as Error).message}`).catch(() => {});
      });
  }
}

export async function handleDraftCallback(
  action: string,
  draftId: string,
  messageId: number,
  env: Env,
  store: Store,
  tg: Telegram,
): Promise<void> {
  const adminId = env.ADMIN_UID;
  const rounds = Number(env.AI_CONTEXT_ROUNDS || '6');
  const draft = await store.getGhostDraft(draftId);
  if (!draft) {
    await tg.editMessageText(adminId, messageId, '⚠️ 草稿已过期，请重新生成。').catch(() => {});
    return;
  }

  if (action === 'send') {
    await sendAiText(tg, draft.userId, draft.draft);
    await store.appendContext(String(draft.userId), { role: 'assistant', content: draft.draft }, rounds);
    await store.deleteGhostDraft(draftId);
    await tg
      .editMessageText(adminId, messageId, `✅ 已发送给 uid:${draft.userId}\n\n${formatTelegramHtml(draft.draft)}`, {
        parse_mode: 'HTML',
      })
      .catch(() => {});
    return;
  }

  if (action === 'regen') {
    await tg.editMessageText(adminId, messageId, '🔄 正在重新生成草稿…').catch(() => {});
    const next: GhostDraft = {
      ...draft,
      id: makeDraftId(draft.userId),
      draft: await generateDraft(draft.userId, draft.intent, env, store),
      createdAt: Date.now(),
    };
    await store.deleteGhostDraft(draftId);
    await store.saveGhostDraft(next);
    await tg.editMessageText(adminId, messageId, draftText(next), {
      parse_mode: 'HTML',
      reply_markup: draftButtons(next.id),
    });
    return;
  }

  if (action === 'manual') {
    await store.deleteGhostDraft(draftId);
    await tg.editMessageText(
      adminId,
      messageId,
      `✍️ 已切换为自行回复。\n\n请直接 reply 用户转发消息输入你的回复，或使用：\n/to ${draft.userId} <你的回复>`,
    );
  }
}
