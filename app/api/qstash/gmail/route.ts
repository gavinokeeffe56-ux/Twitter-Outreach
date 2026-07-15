import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { processGmailBatch } from '@/lib/jobs';

export const maxDuration = 300;

async function handler(req: Request) {
  const { userId, leadIds } = await req.json();
  await processGmailBatch(userId, leadIds);
  return Response.json({ ok: true });
}

export const POST = verifySignatureAppRouter(handler);
