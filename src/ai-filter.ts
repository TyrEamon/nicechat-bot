import type { Env, Classification, SpamCategory, ChatTurn } from './types';
import { keywordHit } from './moderation';

const SYSTEM_PROMPT =
  '你是一个消息安全分类器。判断用户发来的一条 Telegram 消息属于哪一类，并只返回一个 JSON 对象，' +
  '不要任何额外文字。类别取值：normal(正常)、ad(广告营销)、scam(诈骗)、spam(垃圾骚扰)。' +
  '输出格式：{"category":"normal|ad|scam|spam","confidence":0~1,"reason":"简短中文理由"}';

function parseClassification(raw: string): Omit<Classification, 'provider'> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { category?: string; confidence?: number; reason?: string };
    const cat = obj.category as SpamCategory;
    if (!['normal', 'ad', 'scam', 'spam'].includes(cat)) return null;
    return {
      category: cat,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
      reason: obj.reason ?? '',
    };
  } catch {
    return null;
  }
}

async function classifyViaRelay(text: string, env: Env, model: string): Promise<Omit<Classification, 'provider'> | null> {
  if (!env.AI_BASE_URL || !env.AI_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.AI_TIMEOUT_MS || '2500'));
  try {
    const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content ?? '';
    return parseClassification(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyViaWorkersAi(text: string, env: Env): Promise<Omit<Classification, 'provider'> | null> {
  try {
    const out = (await env.AI.run(env.CF_AI_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    })) as { response?: string };
    return parseClassification(out.response ?? '');
  } catch {
    return null;
  }
}

// Multi-tier: relay -> workers ai -> keyword -> default allow.
export async function classifyMessage(text: string, env: Env, model = env.AI_MODEL): Promise<Classification> {
  const provider = env.AI_PROVIDER || 'auto';
  const fallbackCf = (env.AI_FALLBACK_TO_CF ?? 'true') === 'true';

  if (provider === 'relay' || provider === 'auto') {
    const r = await classifyViaRelay(text, env, model);
    if (r) return { ...r, provider: 'relay' };
  }
  if (provider === 'workers_ai' || (provider === 'auto' && fallbackCf) || (provider === 'relay' && fallbackCf)) {
    const r = await classifyViaWorkersAi(text, env);
    if (r) return { ...r, provider: 'workers_ai' };
  }
  // keyword fallback
  if (keywordHit(text, env)) {
    return { category: 'spam', confidence: 1, reason: '命中屏蔽关键词', provider: 'keyword' };
  }
  return { category: 'normal', confidence: 0, reason: '未过滤(AI 不可用)', provider: 'none' };
}

const BLOCK_CATEGORIES: SpamCategory[] = ['ad', 'scam', 'spam'];

export function shouldIntercept(c: Classification, env: Env): boolean {
  if ((env.FILTER_ENABLED ?? 'true') !== 'true') return false;
  const threshold = Number(env.FILTER_THRESHOLD || '0.6');
  return BLOCK_CATEGORIES.includes(c.category) && c.confidence >= threshold;
}

// Generic chat completion for ghostwriter / assistant, reusing the multi-tier channel.
export async function chatComplete(messages: ChatTurn[], env: Env, systemPrompt: string, model = env.AI_MODEL): Promise<string> {
  const full = [{ role: 'system' as const, content: systemPrompt }, ...messages];
  const provider = env.AI_PROVIDER || 'auto';

  if (provider === 'relay' || provider === 'auto') {
    if (env.AI_BASE_URL && env.AI_API_KEY) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number(env.AI_TIMEOUT_MS || '60000'));
      try {
        const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
          body: JSON.stringify({ model, messages: full }),
          signal: controller.signal,
        });
        if (res.ok) {
          const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          const content = json.choices?.[0]?.message?.content;
          if (content) return content;
        }
      } catch {
        /* fall through to CF */
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  try {
    const out = (await env.AI.run(env.CF_AI_MODEL, { messages: full })) as { response?: string };
    if (out.response) return out.response;
  } catch {
    /* fall through */
  }
  return 'AI 暂时不可用，请稍后再试。';
}

// List available models from the OpenAI-compatible relay station (GET /models).
export async function listModels(env: Env): Promise<string[]> {
  if (!env.AI_BASE_URL || !env.AI_API_KEY) return [];
  try {
    const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${env.AI_API_KEY}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id?: string }[] };
    return (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

