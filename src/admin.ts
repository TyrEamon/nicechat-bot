import type { Env, TgMessage } from './types';
import { Store } from './store';
import { Telegram } from './telegram';
import { handleAssistant, handleGhostwrite } from './assistant';

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
