import type { Env } from './types';
import { Store } from './store';
import { Telegram } from './telegram';
import { chatComplete } from './ai-filter';

const ASSISTANT_PROMPT = '你是机器人主人的私人助理，简洁、专业地协助主人处理日常事务与问题。';
const GHOST_PROMPT =
  '你在替机器人的主人回复一位陌生用户。请根据主人给出的“意向”和此前的会话上下文，' +
  '生成一条得体、简洁、礼貌的回复，直接输出回复正文，不要解释。';

// /ai <question>  (no reply): chat with the personal assistant.
export async function handleAssistant(question: string, env: Env, store: Store, tg: Telegram): Promise<void> {
  const adminId = env.ADMIN_UID;
  const rounds = Number(env.AI_CONTEXT_ROUNDS || '6');
  const history = await store.getContext('admin');
  history.push({ role: 'user', content: question });
  const answer = await chatComplete(history, env, ASSISTANT_PROMPT);
  await store.appendContext('admin', { role: 'user', content: question }, rounds);
  await store.appendContext('admin', { role: 'assistant', content: answer }, rounds);
  await tg.sendMessage(adminId, answer);
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
  const ctx = await store.getContext(String(userId));
  const messages = [...ctx, { role: 'user' as const, content: `主人的回复意向：${intent}` }];
  const draft = await chatComplete(messages, env, GHOST_PROMPT);

  if ((env.AI_REPLY_PREVIEW || 'preview') === 'send') {
    await tg.sendMessage(userId, draft);
    await store.appendContext(String(userId), { role: 'assistant', content: draft }, rounds);
    await tg.sendMessage(adminId, `✅ 已按意向回复 uid:${userId}：\n${draft}`);
  } else {
    await tg.sendMessage(
      adminId,
      `📝 代笔草稿（回复 uid:${userId}）：\n\n${draft}\n\n如满意，请 reply 本条草稿并发送 /send 确认发出，或直接 reply 用户消息手动回复。`,
    );
    // Stash draft so /send can pick it up.
    await store.appendContext(`draft:${userId}`, { role: 'assistant', content: draft }, 1);
  }
}
