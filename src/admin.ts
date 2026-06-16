import type { Env, TgMessage } from './types';
import { Store } from './store';
import { Telegram } from './telegram';
import { handleAssistant, handleGhostwrite } from './assistant';
import { listModels } from './ai-filter';

// Handles messages coming from the admin's private chat with the bot.
export async function handleAdminMessage(msg: TgMessage, env: Env, store: Store, tg: Telegram): Promise<void> {
  const adminId = env.ADMIN_UID;
  const text = (msg.text ?? msg.caption ?? '').trim();
  const replied = msg.reply_to_message;

  // Commands
  if (text.startsWith('/block') || text.startsWith('/unblock')) {
    const uid = await targetUid(text, replied, store);
    if (!uid) return void tg.sendMessage(adminId, '用法：reply 用户消息后发 /block，或 /block <uid>');
    if (text.startsWith('/unblock')) {
      await store.unblock(uid);
      return void tg.sendMessage(adminId, `已解封 uid:${uid}`);
    }
    await store.block(uid);
    return void tg.sendMessage(adminId, `已拉黑 uid:${uid}`);
  }

  if (text.startsWith('/model')) {
    const arg = text.replace(/^\/model\s*/, '').trim();
    if (!arg) {
      const cur = (await store.getActiveModel()) || env.AI_MODEL;
      return void tg.sendMessage(adminId, `当前模型：${cur}\n用法：\n/model list 查看可用模型\n/model <模型名> 切换\n/model default 恢复默认(${env.AI_MODEL})`);
    }
    if (arg === 'list') {
      const models = await listModels(env);
      if (!models.length) return void tg.sendMessage(adminId, '未能获取模型列表（检查 AI_BASE_URL / AI_API_KEY，或中转站不支持 /models）。');
      const cur = (await store.getActiveModel()) || env.AI_MODEL;
      const list = models.map((m) => (m === cur ? `• ${m}  ← 当前` : `• ${m}`)).join('\n');
      await tg.sendLong(adminId, `可用模型（共 ${models.length}）：\n${list}`);
      return;
    }
    if (arg === 'default') {
      await store.clearActiveModel();
      return void tg.sendMessage(adminId, `已恢复默认模型：${env.AI_MODEL}`);
    }
    await store.setActiveModel(arg);
    return void tg.sendMessage(adminId, `已切换模型为：${arg}`);
  }

  if (text.startsWith('/to ')) {
    const m = text.match(/^\/to\s+(\d+)\s+([\s\S]+)$/);
    if (!m) return void tg.sendMessage(adminId, '用法：/to <uid> 内容');
    await tg.sendMessage(Number(m[1]), m[2]);
    return;
  }

  if (text.startsWith('/ai')) {
    const intent = text.replace(/^\/ai\s*/, '').trim();
    if (!intent) return void tg.sendMessage(adminId, '用法：/ai <问题> 或 reply 转发消息后 /ai <意向>');
    if (replied) {
      const uid = await store.resolveAdminMsg(replied.message_id);
      if (uid) return void handleGhostwrite(uid, intent, env, store, tg);
    }
    return void handleAssistant(intent, env, store, tg);
  }

  // Plain reply to a forwarded message -> relay back to that user.
  if (replied) {
    const uid = await store.resolveAdminMsg(replied.message_id);
    if (uid) {
      await tg.copyMessage(uid, msg.chat.id, msg.message_id);
      return;
    }
  }

  await tg.sendMessage(adminId, 'ℹ️ 请 reply 某条转发消息来回复用户，或用 /to <uid> 指定对象，或 /ai <问题> 找助理。');
}

async function targetUid(text: string, replied: TgMessage | undefined, store: Store): Promise<number | null> {
  const m = text.match(/\b(\d{4,})\b/);
  if (m) return Number(m[1]);
  if (replied) return store.resolveAdminMsg(replied.message_id);
  return null;
}
