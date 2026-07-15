# Outreach Pipeline (web)

Multi-tenant SaaS version of the outreach pipeline. Each person signs in with Google, gets a private workspace, imports their X followers list, and runs AI classification, email discovery, and one-click Gmail drafts — all serverless on Vercel.

## Architecture

| Concern | Tech |
|---|---|
| Framework / hosting | Next.js (App Router) on Vercel |
| Auth | Auth.js (NextAuth v5), Google provider — one sign-in grants login **and** Gmail Drafts access |
| Database | Neon Postgres via Drizzle ORM (every row scoped to `owner_id`) |
| Background jobs | Upstash **QStash** (serverless queue with flow control + retries) |
| Rate-limiting + job progress | Upstash **Redis** |
| Secrets at rest | Per-user API keys AES-256-GCM encrypted (`lib/crypto.ts`) |

**Why QStash:** Vercel functions are stateless and time out, so the old in-memory job loops can't exist here. Each classify / email-hunt / Gmail-push run publishes small batches of leads to QStash, which calls the `/api/qstash/*` consumers with **flow control** (parallelism + rate caps) so we never blow past Anthropic / Hunter / Gmail limits. Progress is tracked in Redis counters, read by `/api/jobs`.

## Prerequisites (all have free tiers)

1. **Neon** — a Postgres database → `DATABASE_URL`
2. **Upstash Redis** → `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
3. **Upstash QStash** → `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
4. **Google Cloud OAuth** — enable the **Gmail API**, configure the OAuth consent screen (External), create a **Web** OAuth client → `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`
   - Authorized redirect URIs: `http://localhost:3000/api/auth/callback/google` **and** `https://YOUR-APP.vercel.app/api/auth/callback/google`
   - Scopes: `openid email profile` + `https://www.googleapis.com/auth/gmail.compose` (the app requests these; add the Gmail scope on the consent screen)

Generate the two local secrets:
```bash
npx auth secret                                                   # AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # ENCRYPTION_KEY
```

## Local development

```bash
cp .env.example .env        # fill in every value
# QStash can't reach localhost, so process jobs inline in dev:
echo 'QSTASH_DEV_INLINE=true' >> .env

npm install
npm run db:push             # creates all tables in Neon
npm run dev                 # http://localhost:3000
```

`QSTASH_DEV_INLINE=true` runs job batches in-process via Next's `after()` instead of publishing to QStash — fine for local testing with small lists. Leave it **unset in production** so QStash handles scale durably.

## Deploy to Vercel

1. Push this folder to a Git repo and import it into Vercel.
2. Add every env var from `.env.example` in the Vercel project settings. Set `APP_URL` to your deployment URL (e.g. `https://your-app.vercel.app`) — QStash uses it to call back into the app. **Do not** set `QSTASH_DEV_INLINE`.
3. Add the production redirect URI to your Google OAuth client (step 4 above).
4. Run the DB migration once against Neon: `npm run db:push` locally with the production `DATABASE_URL`, or use the Neon SQL editor with the generated SQL in `drizzle/`.
5. Deploy.

**Vercel plan note:** the QStash consumer routes declare `maxDuration = 300`. That needs a plan that allows long function durations (Pro/Fluid compute). On Hobby they'll cap lower — reduce the `BATCH` size in `lib/qstash.ts` (e.g. 2–3 leads per message) so each invocation stays under the cap.

## The pipeline

Import CSV → free heuristic scoring → **✨ Classify with AI** → **📧 Find emails** (bio → website → Hunter.io) → **💾 Push to Gmail** (AI-drafts the missing ones, saves all to your Drafts) → review & send from Gmail → drag through the pipeline board as replies come in. Per-lead, the drawer also offers copy-and-open X DM and copy-and-open email, each auto-marking Contacted.

## Gmail caveat

Google keeps Gmail-scope apps in "testing" mode until verified, which expires each user's granted access ~weekly. Reconnecting = sign out and back in. To remove the weekly expiry, submit the app for Google OAuth verification (or keep users on your test-user list).

## Notes on cost & safety

- AI cost scales with the model (Opus 4.8 ≈ $9/1k classified, Haiku 4.5 ≈ $1.60/1k) and users bring their own API key in Settings.
- Cold email: keep it CAN-SPAM-compliant, send in modest daily batches from a warmed address. The app drafts — it never auto-sends.
