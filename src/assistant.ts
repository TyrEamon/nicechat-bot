import type { Env } from './types';
import { Store } from './store';
import { Telegram } from './telegram';
import { chatComplete } from './ai-filter';

const ASSISTANT_PROMPT = '你是机器人主人的私人助理，简洁、专业地协助主人处理日常事务与问题。';
const GHOST_PROMPT =
  '你在替机器人的主人回复一位陌生用户。请根据主人给出的“意向”和此前的会话上下文，' +
  '生成一条得体、简洁、礼貌的回复，直接输出回复正文，不要解释。';

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

    await tg.sendLong(adminId, finalText);
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
  const rounds = Number(env.AI_CONTEXT_ROUNDS || '6');
  const ack = await tg.sendMessage(adminId, '✍️ 代笔中…');
  let draft: string;

  try {
    const ctx = await store.getContext(String(userId));
    const messages = [...ctx, { role: 'user' as const, content: `主人的回复意向：${intent}` }];
    const model = (await store.getActiveModel()) || env.AI_MODEL;
    draft = await chatComplete(messages, env, GHOST_PROMPT, model);
  } catch (e) {
    await tg
      .editMessageText(adminId, ack.message_id, `⚠️ 代笔出错：${(e as Error).message}`)
      .catch(async () => {
        await tg.sendMessage(adminId, `⚠️ 代笔出错：${(e as Error).message}`).catch(() => {});
      });
    return;
  }

  const finalDraft = draft && draft.trim() ? draft : '(AI 返回了空草稿，可能超时或模型无输出)';

  if ((env.AI_REPLY_PREVIEW || 'preview') === 'send') {
    await tg.sendMessage(userId, finalDraft);
    await store.appendContext(String(userId), { role: 'assistant', content: finalDraft }, rounds);
    await tg.editMessageText(adminId, ack.message_id, `✅ 已按意向回复 uid:${userId}`).catch(() => {});
  } else {
    await tg.editMessageText(adminId, ack.message_id, '✅ 草稿已生成').catch(() => {});
    await tg.sendLong(
      adminId,
      `📝 代笔草稿（回复 uid:${userId}）：\n\n${finalDraft}\n\n满意的话用 /to ${userId} <内容> 发出，或 reply 用户消息手动回复。`,
    );
  }
}
