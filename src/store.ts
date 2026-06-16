import type { Env, UserProfile, ChatTurn } from './types';

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

  // ---- reply mapping: admin message id -> user id ----
  mapAdminMsg(adminMsgId: number, userId: number, ttl = 60 * 60 * 24 * 7): Promise<void> {
    return this.kv.put(`msgmap:${adminMsgId}`, String(userId), { expirationTtl: ttl });
  }

  async resolveAdminMsg(adminMsgId: number): Promise<number | null> {
    const v = await this.kv.get(`msgmap:${adminMsgId}`);
    return v ? Number(v) : null;
  }

  // ---- blocklist ----
  block(userId: number, reason = '1'): Promise<void> {
    return this.kv.put(`block:${userId}`, reason);
  }

  unblock(userId: number): Promise<void> {
    return this.kv.delete(`block:${userId}`);
  }

  async isBlocked(userId: number): Promise<boolean> {
    return (await this.kv.get(`block:${userId}`)) !== null;
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
  saveIntercepted(id: string, data: unknown): Promise<void> {
    return this.putJSON(`intercepted:${id}`, data, 60 * 60 * 24 * 30);
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
}

export function makeStore(env: Env): Store {
  return new Store(env.TG_BOT_KV);
}
