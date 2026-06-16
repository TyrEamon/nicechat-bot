import type { Env } from './types';

// Keyword fallback used when AI is unavailable.
export function keywordHit(text: string, env: Env): boolean {
  const raw = (env.BLOCK_KEYWORDS || '').trim();
  if (!raw) return false;
  const words = raw.split(/[|\n]/).map((w) => w.trim()).filter(Boolean);
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

export function isAdmin(env: Env, fromId?: number): boolean {
  return !!fromId && String(fromId) === String(env.ADMIN_UID);
}
