import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from './db';
import { users, accounts, sessions, verificationTokens } from './db/schema';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens
  }),
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // One consent screen logs the user in AND grants Gmail draft access.
      authorization: {
        params: {
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.compose',
          access_type: 'offline',
          prompt: 'consent'
        }
      }
    })
  ],
  session: { strategy: 'database' },
  callbacks: {
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    }
  },
  pages: { signIn: '/login' }
});
