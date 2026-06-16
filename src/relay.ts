import type { Env, TgMessage } from './types';
import { Store } from './store';
import { Telegram, senderHeader } from './telegram';

// Abstraction over relay target so group/topic mode can be added later (RELAY_MODE=group).
export interface RelayTarget {
  // Forward a user's message to the admin side and record reply mapping.
  deliverToAdmin(msg: TgMessage): Promise<void>;
}

class PrivateRelay implements RelayTarget {
  constructor(private env: Env, private store: Store, private tg: Telegram) {}

  async deliverToAdmin(msg: TgMessage): Promise<void> {
    const adminId = this.env.ADMIN_UID;
    const fromId = msg.from!.id;

    // Header so the admin knows who sent it.
    await this.tg.sendMessage(adminId, senderHeader(msg.from));
    // Copy the actual content (text/photo/file/sticker...).
    const copied = await this.tg.copyMessage(adminId, msg.chat.id, msg.message_id);
    // Map admin-side message id -> user id, so admin can reply.
    await this.store.mapAdminMsg(copied.message_id, fromId);
  }
}

export function makeRelay(env: Env, store: Store, tg: Telegram): RelayTarget {
  // group mode reserved but not enabled in v1.
  // if (env.RELAY_MODE === 'group') return new GroupRelay(...);
  return new PrivateRelay(env, store, tg);
}
