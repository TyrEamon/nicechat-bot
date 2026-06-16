import type { TgUser } from './types';

const API = 'https://api.telegram.org/bot';

export class Telegram {
  constructor(private token: string) {}

  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
    return json.result as T;
  }

  sendMessage(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
    return this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, ...extra });
  }

  async sendLong(chatId: number | string, text: string): Promise<void> {
    const MAX = 4000;
    if (text.length <= MAX) {
      await this.sendMessage(chatId, text);
      return;
    }
    for (let i = 0; i < text.length; i += MAX) {
      await this.sendMessage(chatId, text.slice(i, i + MAX));
    }
  }

  editMessageText(chatId: number | string, messageId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
  }

  copyMessage(toChatId: number | string, fromChatId: number | string, messageId: number, extra: Record<string, unknown> = {}) {
    return this.call<{ message_id: number }>('copyMessage', {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      ...extra,
    });
  }

  forwardMessage(toChatId: number | string, fromChatId: number | string, messageId: number) {
    return this.call<{ message_id: number }>('forwardMessage', {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  setMyCommands(commands: { command: string; description: string }[], scope?: Record<string, unknown>) {
    return this.call('setMyCommands', { commands, ...(scope ? { scope } : {}) });
  }

  setWebhook(url: string, secretToken: string) {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    });
  }

  deleteWebhook() {
    return this.call('deleteWebhook', {});
  }
}

export function displayName(u?: TgUser): string {
  if (!u) return 'unknown';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return name || u.username || String(u.id);
}

export function senderHeader(u?: TgUser): string {
  const name = displayName(u);
  const at = u?.username ? ` @${u.username}` : '';
  return `👤 ${name}${at} (uid:${u?.id})`;
}
