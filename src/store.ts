import type { Env, UserProfile, ChatTurn } from './types';

export interface GhostDraft {
  id: string;
  userId: number;
  intent: string;
  draft: string;
  createdAt: number;
}

export interface BlockInfo {
  userId: number;
  reason: string;
  source: 'manual' | 'auto';
  createdAt: number;
}

export interface InterceptedRecord {
  id: string;
  userId: number;
  text: string;
  category: string;
  confidence?: number;
  reason: string;
  provider: string;
  time: number;
  violationCount?: number;
}

// Thin KV wrapper. All KV key conventions live here.
export class Store {
  constructor(private kv: KVNamespace) {}

  private async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private putJSON(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    return this.kv.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  }

  // ---- user profile ----
  getUser(userId: number): Promise<UserProfile | null> {
    return this.getJSON<UserProfile>(`user:${userId}`);
  }

  saveUser(profile: UserProfile): Promise<void> {
    return this.putJSON(`user:${profile.id}`, profile);
  }

  // ---- verification temp state ----
  setVerifyAnswer(userId: number, answer: string, ttl = 600): Promise<void> {
    return this.putJSON(`verify:${userId}`, { answer, tries: 0 }, ttl);
  }

  getVerify(userId: number): Promise<{ answer: string; tries: number } | null> {
    return this.getJSON(`verify:${userId}`);
  }

  bumpVerifyTries(userId: number, current: { answer: string; tries: number }): Promise<void> {
    return this.putJSON(`verify:${userId}`, { ...current, tries: current.tries + 1 }, 600);
  }

  clearVerify(userId: number): Promise<void> {
    return this.kv.delete(`verify:${userId}`);
  }

  async resetVerification(userId: number): Promise<void> {
    const profile = await this.getUser(userId);
    if (profile) {
      profile.verified = false;
      await this.saveUser(profile);
    }
    await this.clearVerify(userId);
  }

  // ---- reply mapping: admin message id -> user id ----
  mapAdminMsg(adminMsgId: number, userId: number, ttl = 60 * 60 * 24 * 7): Promise<void> {
    return this.kv.put(`msgmap:${adminMsgId}`, String(userId), { expirationTtl: ttl });
  }

  async resolveAdminMsg(adminMsgId: number): Promise<number | null> {
    const v = await this.kv.get(`msgmap:${adminMsgId}`);
    return v ? Number(v) : null;
  }

  // ---- blocklist ----
  async block(userId: number, reason = 'blocked', source: 'manual' | 'auto' = 'manual'): Promise<void> {
    const info: BlockInfo = { userId, reason, source, createdAt: Date.now() };
    await this.putJSON(`block:${userId}`, info);
  }

  async unblock(userId: number): Promise<void> {
    await this.kv.delete(`block:${userId}`);
    await this.clearViolations(userId);
    await this.clearAppeals(userId);
  }

  async getBlockInfo(userId: number): Promise<BlockInfo | null> {
    const parsed = await this.getJSON<BlockInfo>(`block:${userId}`);
    if (parsed) return parsed;
    const raw = await this.kv.get(`block:${userId}`);
    return raw ? { userId, reason: raw, source: 'manual', createdAt: 0 } : null;
  }

  async isBlocked(userId: number): Promise<boolean> {
    return (await this.getBlockInfo(userId)) !== null;
  }

  // ---- violations / auto ban ----
  async incrementViolation(userId: number): Promise<number> {
    const key = `violations:${userId}`;
    const count = Number((await this.kv.get(key)) ?? '0') + 1;
    await this.kv.put(key, String(count), { expirationTtl: 60 * 60 * 24 * 30 });
    return count;
  }

  async getViolationCount(userId: number): Promise<number> {
    return Number((await this.kv.get(`violations:${userId}`)) ?? '0');
  }

  clearViolations(userId: number): Promise<void> {
    return this.kv.delete(`violations:${userId}`);
  }

  // ---- appeal attempts ----
  async incrementAppeal(userId: number): Promise<number> {
    const key = `appeals:${userId}`;
    const count = Number((await this.kv.get(key)) ?? '0') + 1;
    await this.kv.put(key, String(count), { expirationTtl: 60 * 60 * 24 * 30 });
    return count;
  }

  async getAppealCount(userId: number): Promise<number> {
    return Number((await this.kv.get(`appeals:${userId}`)) ?? '0');
  }

  clearAppeals(userId: number): Promise<void> {
    return this.kv.delete(`appeals:${userId}`);
  }

  // ---- rate limit (per minute window) ----
  async hitRate(userId: number, limit: number, windowSec = 60): Promise<boolean> {
    const key = `rate:${userId}`;
    const cur = Number((await this.kv.get(key)) ?? '0');
    if (cur >= limit) return false;
    await this.kv.put(key, String(cur + 1), { expirationTtl: windowSec });
    return true;
  }

  // ---- idempotency for update_id ----
  async seenUpdate(updateId: number): Promise<boolean> {
    const key = `upd:${updateId}`;
    if (await this.kv.get(key)) return true;
    await this.kv.put(key, '1', { expirationTtl: 600 });
    return false;
  }

  // ---- intercepted messages ----
  async saveIntercepted(record: InterceptedRecord): Promise<void> {
    await this.putJSON(`intercepted:${record.id}`, record, 60 * 60 * 24 * 30);
    const index = await this.getInterceptedIndex(100);
    const next = [record, ...index.filter((item) => item.id !== record.id)].slice(0, 100);
    await this.putJSON('intercepted:index', next, 60 * 60 * 24 * 30);
  }

  async getInterceptedIndex(limit = 10): Promise<InterceptedRecord[]> {
    const items = (await this.getJSON<InterceptedRecord[]>('intercepted:index')) ?? [];
    return items.slice(0, limit);
  }

  // ---- admin AI chat mode ----
  async getAdminAiMode(): Promise<boolean> {
    return (await this.kv.get('cfg:admin_ai_mode')) === 'on';
  }

  setAdminAiMode(on: boolean): Promise<void> {
    return on ? this.kv.put('cfg:admin_ai_mode', 'on') : this.kv.delete('cfg:admin_ai_mode');
  }

  // ---- active AI model override ----
  getActiveModel(): Promise<string | null> {
    return this.kv.get('cfg:model');
  }

  setActiveModel(model: string): Promise<void> {
    return this.kv.put('cfg:model', model);
  }

  clearActiveModel(): Promise<void> {
    return this.kv.delete('cfg:model');
  }

  // ---- bot profile cache ----
  getBotUsername(): Promise<string | null> {
    return this.kv.get('cfg:bot_username');
  }

  setBotUsername(username: string): Promise<void> {
    return this.kv.put('cfg:bot_username', username, { expirationTtl: 60 * 60 * 24 });
  }

  // ---- ghostwrite drafts ----
  saveGhostDraft(draft: GhostDraft, ttl = 60 * 60): Promise<void> {
    return this.putJSON(`draft:${draft.id}`, draft, ttl);
  }

  getGhostDraft(id: string): Promise<GhostDraft | null> {
    return this.getJSON<GhostDraft>(`draft:${id}`);
  }

  deleteGhostDraft(id: string): Promise<void> {
    return this.kv.delete(`draft:${id}`);
  }

  // ---- conversation context ----
  async getContext(key: string): Promise<ChatTurn[]> {
    return (await this.getJSON<ChatTurn[]>(`ctx:${key}`)) ?? [];
  }

  async appendContext(key: string, turn: ChatTurn, maxRounds: number): Promise<void> {
    const turns = await this.getContext(key);
    turns.push(turn);
    const maxItems = maxRounds * 2;
    const trimmed = turns.slice(-maxItems);
    await this.putJSON(`ctx:${key}`, trimmed, 60 * 60 * 24 * 7);
  }

  // ---- group AI concurrency / cooldown ----
  async tryAcquireGroupLock(chatId: number, limit: number, ttlSeconds: number): Promise<boolean> {
    const key = `lock:group:${chatId}`;
    const current = Number((await this.kv.get(key)) ?? '0');
    if (current >= limit) return false;
    await this.kv.put(key, String(current + 1), { expirationTtl: ttlSeconds });
    return true;
  }

  async releaseGroupLock(chatId: number): Promise<void> {
    const key = `lock:group:${chatId}`;
    const current = Number((await this.kv.get(key)) ?? '0');
    if (current <= 1) {
      await this.kv.delete(key);
      return;
    }
    await this.kv.put(key, String(current - 1), { expirationTtl: 120 });
  }

  async hitGroupUserCooldown(chatId: number, userId: number, seconds: number): Promise<boolean> {
    if (seconds <= 0) return true;
    const key = `cooldown:group:${chatId}:${userId}`;
    if (await this.kv.get(key)) return false;
    await this.kv.put(key, '1', { expirationTtl: seconds });
    return true;
  }
}

export function makeStore(env: Env): Store {
  return new Store(env.TG_BOT_KV);
}
