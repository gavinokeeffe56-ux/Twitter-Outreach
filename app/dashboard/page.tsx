import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import Dashboard from '@/components/Dashboard';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  async function doSignOut() {
    'use server';
    await signOut({ redirectTo: '/login' });
  }

  return (
    <Dashboard
      userEmail={session.user.email ?? ''}
      userImage={session.user.image ?? ''}
      signOutAction={doSignOut}
    />
  );
}
