import type { Env, TgMessage } from './types';
import { Store } from './store';
import { Telegram } from './telegram';
import { handleAssistant, handleGhostwrite } from './assistant';
import { listModels } from './ai-filter';

// Handles messages coming from the admin's private chat with the bot.
export async function handleAdminMessage(
  msg: TgMessage,
  env: Env,
  store: Store,
  tg: Telegram,
): Promise<void> {
  const adminId = env.ADMIN_UID;
  const text = (msg.text ?? msg.caption ?? '').trim();
  const replied = msg.reply_to_message;

  // Commands
  if (text.startsWith('/aimode')) {
    const arg = text.replace(/^\/aimode\s*/, '').trim().toLowerCase();
    if (arg === 'on') {
      await store.setAdminAiMode(true);
      await tg.sendMessage(adminId, '✅ 已进入 AI 模式。之后直接发普通消息就是和助理聊天；/aimode off 退出。');
      return;
    }
    if (arg === 'off') {
      await store.setAdminAiMode(false);
      await tg.sendMessage(adminId, '✅ 已退出 AI 模式。');
      return;
    }
    const on = await store.getAdminAiMode();
    await tg.sendMessage(adminId, `AI 模式：${on ? '开启' : '关闭'}\n用法：/aimode on 或 /aimode off`);
    return;
  }

  if (text.startsWith('/block') || text.startsWith('/unblock')) {
    const uid = await targetUid(text, replied, store);
    if (!uid) {
      await tg.sendMessage(adminId, '用法：reply 用户消息后发 /block，或 /block <uid>');
      return;
    }
    if (text.startsWith('/unblock')) {
      await store.unblock(uid);
      await tg.sendMessage(adminId, `已解封 uid:${uid}`);
      return;
    }
    await store.block(uid);
    await tg.sendMessage(adminId, `已拉黑 uid:${uid}`);
    return;
  }

  if (text.startsWith('/model')) {
    const arg = text.replace(/^\/model\s*/, '').trim();
    if (!arg) {
      const cur = (await store.getActiveModel()) || env.AI_MODEL;
      await tg.sendMessage(
        adminId,
        `当前模型：${cur}\n用法：\n/model list 查看可用模型\n/model <模型名> 切换\n/model default 恢复默认(${env.AI_MODEL})`,
      );
      return;
    }
    if (arg === 'list') {
      const models = await listModels(env);
      if (!models.length) {
        await tg.sendMessage(adminId, '未能获取模型列表（检查 AI_BASE_URL / AI_API_KEY，或中转站不支持 /models）。');
        return;
      }
      const cur = (await store.getActiveModel()) || env.AI_MODEL;
      const list = models.map((m) => (m === cur ? `• ${m}  ← 当前` : `• ${m}`)).join('\n');
      await tg.sendLong(adminId, `可用模型（共 ${models.length}）：\n${list}`);
      return;
    }
    if (arg === 'default') {
      await store.clearActiveModel();
      await tg.sendMessage(adminId, `已恢复默认模型：${env.AI_MODEL}`);
      return;
    }
    await store.setActiveModel(arg);
    await tg.sendMessage(adminId, `已切换模型为：${arg}`);
    return;
  }

  if (text.startsWith('/to ')) {
    const m = text.match(/^\/to\s+(\d+)\s+([\s\S]+)$/);
    if (!m) {
      await tg.sendMessage(adminId, '用法：/to <uid> 内容');
      return;
    }
    await tg.sendMessage(Number(m[1]), m[2]);
    return;
  }

  if (text.startsWith('/ai')) {
    const intent = text.replace(/^\/ai\s*/, '').trim();
    if (!intent) {
      await tg.sendMessage(adminId, '用法：/ai <问题> 或 reply 转发消息后 /ai <意向>');
      return;
    }
    if (replied) {
      const uid = await store.resolveAdminMsg(replied.message_id);
      if (uid) {
        await handleGhostwrite(uid, intent, env, store, tg);
        return;
      }
    }
    await handleAssistant(intent, env, store, tg);
    return;
  }

  // Plain reply to a forwarded message -> relay back to that user.
  if (replied) {
    const uid = await store.resolveAdminMsg(replied.message_id);
    if (uid) {
      await tg.copyMessage(uid, msg.chat.id, msg.message_id);
      return;
    }
  }

  // AI mode: plain admin messages go to the assistant without needing /ai.
  if (text && !text.startsWith('/') && (await store.getAdminAiMode())) {
    await handleAssistant(text, env, store, tg);
    return;
  }

  await tg.sendMessage(adminId, 'ℹ️ 请 reply 某条转发消息来回复用户，或用 /to <uid> 指定对象，或 /ai <问题> 找助理。');
}

async function targetUid(text: string, replied: TgMessage | undefined, store: Store): Promise<number | null> {
  const m = text.match(/\b(\d{4,})\b/);
  if (m) return Number(m[1]);
  if (replied) return store.resolveAdminMsg(replied.message_id);
  return null;
}
