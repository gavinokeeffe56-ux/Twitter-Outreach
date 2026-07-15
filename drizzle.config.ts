import { config } from 'dotenv';
import type { Config } from 'drizzle-kit';

// Load local env so `npm run db:push` picks up DATABASE_URL (.env.local wins).
config({ path: '.env.local' });
config({ path: '.env' });

export default {
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! }
} satisfies Config;
