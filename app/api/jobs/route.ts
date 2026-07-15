import { NextResponse } from 'next/server';
import { requireUser, isResponse } from '@/lib/api';
import { getJob } from '@/lib/redis';

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const [classify, email, gmail] = await Promise.all([
    getJob(user, 'classify'), getJob(user, 'email'), getJob(user, 'gmail')
  ]);
  return NextResponse.json({ classify, email, gmail });
}
