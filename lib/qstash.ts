import { Client } from '@upstash/qstash';

export const qstash = new Client({ token: process.env.QSTASH_TOKEN! });

const BATCH = 5; // leads per QStash message — balances invocation count vs per-function runtime

export function chunk<T>(arr: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Publish one message per batch of leads to a consumer route, with flow control
// so we never blow past downstream (Anthropic / Hunter / Gmail) rate limits.
export async function publishBatches(path: string, userId: string, ids: number[], flowKey: string) {
  const url = `${process.env.APP_URL}${path}`;
  const batches = chunk(ids);
  await qstash.batchJSON(
    batches.map((leadIds) => ({
      url,
      body: { userId, leadIds },
      flowControl: { key: `${flowKey}:${userId}`, parallelism: 5, ratePerSecond: 5 },
      retries: 3
    }))
  );
  return batches.length;
}
