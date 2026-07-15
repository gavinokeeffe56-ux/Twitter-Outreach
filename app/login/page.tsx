import { redirect } from 'next/navigation';
import { auth, signIn } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function Login() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');

  return (
    <main className="login">
      <div className="login-card">
        <div className="brand-lg">🎙️ Outreach Pipeline</div>
        <p>Turn your X followers list into a qualified guest &amp; sponsor pipeline — with AI classification, email discovery, and one-click Gmail drafts.</p>
        <form action={async () => { 'use server'; await signIn('google', { redirectTo: '/dashboard' }); }}>
          <button className="btn primary big" type="submit">Sign in with Google</button>
        </form>
        <p className="muted small">Signing in also connects Gmail so drafts can be saved to your Drafts folder. Your data is private to your account.</p>
      </div>
    </main>
  );
}
