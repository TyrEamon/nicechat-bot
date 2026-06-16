import type { Env } from './types';
import { Store } from './store';
import { Telegram } from './telegram';
import { chatCompleteStream } from './ai-filter';

const ASSISTANT_PROMPT = '你是机器人主人的私人助理，简洁、专业地协助主人处理日常事务与问题。';
const GHOST_PROMPT =
  '你在替机器人的主人回复一位陌生用户。请根据主人给出的“意向”和此前的会话上下文，' +
  '生成一条得体、简洁、礼貌的回复，直接输出回复正文，不要解释。';

// Simple streaming progress editor: edits the placeholder at most every ~1.5s,
// and always edits once more at the end with the final text.
function makeEditor(tg: Telegram, chatId: number | string, messageId: number) {
  let lastEditAt = 0;
  let shownText = '';
  const MIN_INTERVAL = 1500;
  return {
    async onProgress(full: string) {
      const now = Date.now();
      if (now - lastEditAt < MIN_INTERVAL) return;
      if (full === shownText || !full) return;
      lastEditAt = now;
      shownText = full;
      await tg.editMessageText(chatId, messageId, full.slice(0, 4000)).catch(() => {});
    },
    async final(full: string) {
      const text = (full || '(AI 返回了空内容)').slice(0, 4000);
      if (text === shownText) return;
      await tg.editMessageText(chatId, messageId, text).catch(async () => {
        await tg.sendMessage(chatId, text).catch(() => {});
      });
    },
  };
}

// /ai <question>  (no reply): chat with the personal assistant.
export async function handleAssistant(question: string, env: Env, store: Store, tg: Telegram): Promise<void> {
  const adminId = env.ADMIN_UID;
  const rounds = Number(env.AI_CONTEXT_ROUNDS || '6');
  const ack = await tg.sendMessage(adminId, '🤔 思考中…');
  const editor = makeEditor(tg, adminId, ack.message_id);
  try {
    const history = await store.getContext('admin');
    history.push({ role: 'user', content: question });
    const model = (await store.getActiveModel()) || env.AI_MODEL;
    const answer = await chatCompleteStream(history, env, ASSISTANT_PROMPT, model, (full) => editor.onProgress(full));
    // Robust delivery: edit the placeholder, and if answer is empty say so explicitly.
    const finalText = answer && answer.trim() ? answer : '(AI 返回了空内容，可能超时或流式无输出)';
    await tg.editMessageText(adminId, ack.message_id, finalText.slice(0, 4000)).catch(async () => {
      await tg.sendMessage(adminId, finalText.slice(0, 4000)).catch(() => {});
    });
    await store.appendContext('admin', { role: 'user', content: question }, rounds);
    await store.appendContext('admin', { role: 'assistant', content: answer }, rounds);
  } catch (e) {
    await tg.editMessageText(adminId, ack.message_id, `⚠️ 助理出错：${(e as Error).message}`).catch(() => {});
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
  const rounds = Number(env.AI_CONTEXT_ROUNDS || '6');
  const ack = await tg.sendMessage(adminId, '✍️ 代笔中…');
  const editor = makeEditor(tg, adminId, ack.message_id);
  let draft: string;
  try {
    const ctx = await store.getContext(String(userId));
    const messages = [...ctx, { role: 'user' as const, content: `主人的回复意向：${intent}` }];
    const model = (await store.getActiveModel()) || env.AI_MODEL;
    draft = await chatCompleteStream(messages, env, GHOST_PROMPT, model, (full) => editor.onProgress(full));
  } catch (e) {
    await tg.editMessageText(adminId, ack.message_id, `⚠️ 代笔出错：${(e as Error).message}`).catch(() => {});
    return;
  }

  if ((env.AI_REPLY_PREVIEW || 'preview') === 'send') {
    await editor.final(draft);
    await tg.sendMessage(userId, draft);
    await store.appendContext(String(userId), { role: 'assistant', content: draft }, rounds);
    await tg.sendMessage(adminId, `✅ 已按意向回复 uid:${userId}`);
  } else {
    await editor.final(
      `📝 代笔草稿（回复 uid:${userId}）：\n\n${draft}\n\n满意的话用 /to ${userId} <内容> 发出，或 reply 用户消息手动回复。`,
    );
  }
}
