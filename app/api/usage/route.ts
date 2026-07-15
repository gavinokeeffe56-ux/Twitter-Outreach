import { NextResponse } from 'next/server';
import { requireUser, isResponse } from '@/lib/api';
import { getUsageSummary } from '@/lib/usage';

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  return NextResponse.json(await getUsageSummary(user));
}
