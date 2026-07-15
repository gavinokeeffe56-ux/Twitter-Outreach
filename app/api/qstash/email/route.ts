import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { processEmailBatch } from '@/lib/jobs';

export const maxDuration = 300;

async function handler(req: Request) {
  const { userId, leadIds } = await req.json();
  await processEmailBatch(userId, leadIds);
  return Response.json({ ok: true });
}

export const POST = verifySignatureAppRouter(handler);
