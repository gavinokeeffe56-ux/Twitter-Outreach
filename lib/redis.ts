import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

export const redis = Redis.fromEnv();

// Per-user rate limits on the expensive actions (protects your API budgets too).
export const startJobLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix: 'rl:startjob'
});

export const singleActionLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '1 m'),
  prefix: 'rl:single'
});

// ---- Job progress, tracked in Redis (no in-memory state in serverless) ----

export type JobKind = 'classify' | 'email' | 'gmail';
export interface JobState {
  status: 'idle' | 'running' | 'done' | 'error';
  total: number;
  done: number;
  found: number;   // classify: strong matches; email hunt: emails found
  drafted: number; // gmail push
  target: number;  // stop early once `found` reaches this (0 = no target)
  errors: number;
  lastError: string | null;
  startedAt: string | null;
}

const jobKey = (userId: string, kind: JobKind) => `job:${userId}:${kind}`;
const EMPTY: JobState = { status: 'idle', total: 0, done: 0, found: 0, drafted: 0, target: 0, errors: 0, lastError: null, startedAt: null };

export async function initJob(userId: string, kind: JobKind, total: number, target = 0) {
  const state: JobState = { ...EMPTY, status: 'running', total, target, startedAt: new Date().toISOString() };
  // Hash fields let workers INCR counters atomically without read-modify-write.
  await redis.hset(jobKey(userId, kind), state as unknown as Record<string, unknown>);
  await redis.expire(jobKey(userId, kind), 60 * 60 * 24);
}

export async function getJob(userId: string, kind: JobKind): Promise<JobState> {
  const raw = await redis.hgetall<Record<string, string>>(jobKey(userId, kind));
  if (!raw || !raw.status) return { ...EMPTY };
  return {
    status: (raw.status as JobState['status']) ?? 'idle',
    total: Number(raw.total) || 0,
    done: Number(raw.done) || 0,
    found: Number(raw.found) || 0,
    drafted: Number(raw.drafted) || 0,
    target: Number(raw.target) || 0,
    errors: Number(raw.errors) || 0,
    lastError: raw.lastError ? String(raw.lastError) : null,
    startedAt: raw.startedAt ? String(raw.startedAt) : null
  };
}

// Atomically bump counters after a batch and flip to `done` when complete.
export async function advanceJob(
  userId: string, kind: JobKind,
  delta: { done?: number; found?: number; drafted?: number; errors?: number; lastError?: string }
) {
  const k = jobKey(userId, kind);
  const p = redis.pipeline();
  if (delta.done) p.hincrby(k, 'done', delta.done);
  if (delta.found) p.hincrby(k, 'found', delta.found);
  if (delta.drafted) p.hincrby(k, 'drafted', delta.drafted);
  if (delta.errors) p.hincrby(k, 'errors', delta.errors);
  if (delta.lastError) p.hset(k, { lastError: delta.lastError });
  const res = await p.exec();
  // Flip to `done` when every batch has run — or early, once the target
  // number of matches is found (remaining queued batches then no-op).
  const state = await getJob(userId, kind);
  if (state.status === 'running' &&
      (state.done >= state.total || (state.target > 0 && state.found >= state.target))) {
    await redis.hset(k, { status: 'done' });
  }
  return res;
}

export async function failJob(userId: string, kind: JobKind, message: string) {
  await redis.hset(jobKey(userId, kind), { status: 'error', lastError: message });
}

export async function stopJob(userId: string, kind: JobKind) {
  const state = await getJob(userId, kind);
  if (state.status === 'running') await redis.hset(jobKey(userId, kind), { status: 'done' });
}
