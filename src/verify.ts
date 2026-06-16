import type { Env, UserProfile } from './types';
import { Store } from './store';
import { Telegram } from './telegram';

function randomIntInclusive(min: number, max: number): number {
  const range = max - min + 1;
  const maxUnbiased = Math.floor(0xffffffff / range) * range;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= maxUnbiased);
  return min + (value % range);
}

// Starts/continues first-time human verification. Returns true if the user is verified.
export async function ensureVerified(
  profile: UserProfile,
  text: string,
  env: Env,
  store: Store,
  tg: Telegram,
): Promise<boolean> {
  if (profile.verified) return true;

  if (text.trim() === '/start') {
    await store.clearVerify(profile.id);
    await issueChallenge(profile, env, store, tg);
    return false;
  }

  const pending = await store.getVerify(profile.id);

  // No challenge yet -> issue one.
  if (!pending) {
    await issueChallenge(profile, env, store, tg);
    return false;
  }

  // Check the answer.
  if (text.trim() === pending.answer) {
    profile.verified = true;
    await store.saveUser(profile);
    await store.clearVerify(profile.id);
    await tg.sendMessage(profile.id, '✅ 验证通过，请发送你的消息。');
    return false; // this message was the answer, not real content
  }

  await store.bumpVerifyTries(profile.id, pending);
  await tg.sendMessage(profile.id, `❌ 答案不对，请再试一次。当前题目答案不是这条消息；如果看不到题目，请发送 /start 重新获取。`);
  return false;
}

async function issueChallenge(profile: UserProfile, env: Env, store: Store, tg: Telegram): Promise<void> {
  const mode = env.VERIFY_MODE || 'math';
  if (mode === 'quiz' && env.VERIFY_QUESTION && env.VERIFY_ANSWER) {
    await store.setVerifyAnswer(profile.id, env.VERIFY_ANSWER.trim());
    await tg.sendMessage(profile.id, `请回答以下问题完成验证：\n${env.VERIFY_QUESTION}`);
    return;
  }
  // default: math
  const a = randomIntInclusive(2, 12);
  const b = randomIntInclusive(2, 12);
  await store.setVerifyAnswer(profile.id, String(a + b));
  await tg.sendMessage(profile.id, `请回答以下算术题完成验证：\n${a} + ${b} = ?`);
}
