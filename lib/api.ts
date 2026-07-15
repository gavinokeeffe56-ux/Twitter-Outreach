import { NextResponse } from 'next/server';
import { auth } from './auth';

// Returns the signed-in user's id, or a 401 Response to return directly.
export async function requireUser(): Promise<string | NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  return session.user.id;
}

export function isResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse;
}
