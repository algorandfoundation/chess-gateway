import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { admin, emailOTP, openAPI } from 'better-auth/plugins';
import SQLite from 'better-sqlite3';
import * as path from 'path';

console.log('[Auth] Initializing Better Auth instance...');

// Public base URL of this service.
const baseURL = process.env.BASE_URL || 'http://localhost:3000';

// Google social SSO is optional: only register the provider when both
// the client id and secret are configured. Operators that haven't wired
// up Google OAuth yet should still get a working gateway (OTP + passkeys).
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const googleEnabled = Boolean(googleClientId && googleClientSecret);
if (!googleEnabled) {
  console.log(
    '[Auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google social provider disabled.',
  );
}

export const auth = betterAuth({
  // Pass the better-sqlite3 Database directly so Better Auth manages the
  // schema (and `npx @better-auth/cli migrate` works) instead of us
  // wrapping a Kysely adapter by hand.
  database: new SQLite(path.join(process.cwd(), 'database.sqlite')),
  baseURL,
  basePath: '/v1/link/auth',
  trustedOrigins: [baseURL],
  secret: process.env.SESSION_AUTH_SECRET || 'a-very-long-and-secure-secret-32-chars!!',
  advanced: {
    disableOriginCheck: true,
    disableCSRFCheck: true,
  },
  // Passwordless system: only OTP, social SSO and passkeys are
  // supported. Email/password sign-in is intentionally disabled.
  emailAndPassword: {
    enabled: false,
  },
  session: {
    additionalFields: {
      challenge: {
        type: 'string',
        required: false,
        input: false,
      },
      // Manager-scoped Vault token minted automatically by the
      // `databaseHooks.session.create.before` hook below whenever an
      // `admin` Better-Auth session is being created. When present on
      // a session it lets the global JWT `AuthGuard` authorise the
      // request without a Bearer JWT — the guard pulls `vaultToken`
      // off the session and treats it as the caller's vault token.
      // `input: false` so clients can't set it themselves.
      vaultToken: {
        type: 'string',
        required: false,
        input: false,
      },
    },
  },
  // Better-Auth lifecycle hook: every time a session is about to be
  // persisted, look up the owning user and — if they're an `admin` —
  // perform an AppRole login against Vault using the manager
  // credentials in `VAULT_ROLE_ID` / `VAULT_SECRET_ID` (propagated by
  // `vault/development-init.ts`) and stash the resulting `vault_token`
  // on the session row as `vaultToken`. The AppRole secret never
  // leaves the gateway; only sessions belonging to an `admin`
  // Better-Auth user (the manager is seeded with `role: 'admin'` —
  // see `seedManagerBetterAuthUser` in `vault/development-init.ts`)
  // ever pick up a token. The token then rides along on the session
  // for subsequent requests; see `src/auth/auth.guard.ts` for the
  // matching pickup logic.
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const userId = (session as { userId?: string }).userId;
          if (!userId) return;
          try {
            // The `auth` instance isn't fully constructed yet inside
            // this hook closure; reach back into the live context to
            // get the adapter the same way `AuthService` does.
            const ctx: any = await (auth as any).$context;
            const user = await ctx.adapter.findOne({
              model: 'user',
              where: [{ field: 'id', value: userId }],
            });
            if (!user) return;

            // Admin sessions get a manager-scoped vault token from the
            // manager AppRole; every other Better-Auth user gets a
            // user-scoped vault token from the dedicated users AppRole.
            // Both AppRole secrets stay on the server; only the issued
            // `client_token` rides on the session row.
            const isAdmin = (user as { role?: string }).role === 'admin';
            const roleId = isAdmin
              ? process.env.VAULT_ROLE_ID?.trim()
              : process.env.USER_VAULT_ROLE_ID?.trim();
            const secretId = isAdmin
              ? process.env.VAULT_SECRET_ID?.trim()
              : process.env.USER_VAULT_SECRET_ID?.trim();
            const vaultBaseUrl = process.env.VAULT_BASE_URL?.trim();
            const scopeLabel = isAdmin ? 'manager' : 'user';
            if (!roleId || !secretId || !vaultBaseUrl) {
              console.warn(
                `[Auth] ${scopeLabel} session created but AppRole credentials / VAULT_BASE_URL not configured — skipping ${scopeLabel} vault token mint.`,
              );
              return;
            }
            const res = await fetch(`${vaultBaseUrl}/v1/auth/approle/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
            });
            if (!res.ok) {
              console.warn(
                `[Auth] ${scopeLabel} AppRole login failed (${res.status}) — session will not carry a vault token.`,
              );
              return;
            }
            const body = (await res.json()) as { auth?: { client_token?: string } };
            const vaultToken = body?.auth?.client_token;
            if (!vaultToken) return;
            return { data: { ...session, vaultToken } };
          } catch (err) {
            console.warn('[Auth] Failed to mint vault token on session create:', err);
            return;
          }
        },
      },
    },
  },
  socialProviders: googleEnabled
    ? {
        google: {
          clientId: googleClientId as string,
          clientSecret: googleClientSecret as string,
        },
      }
    : {},
  plugins: [
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        console.log(`[OTP] To: ${email}, OTP: ${otp}, Type: ${type}`);
      },
      expiresIn: 3600,
      storeOTP: 'plain',
    }),
    // Admin plugin gives us role-based access (`user` / `admin`) plus
    // the impersonation endpoints the manager UI uses to act on behalf
    // of an Intermezzo user. The manager is just an `admin` Better-Auth
    // user seeded at init time — see `seedManagerBetterAuthUser` in
    // `vault/development-init.ts`. The binding to `pawn/managers/manager`
    // is implicit via the manager AppRole credentials in `.env`
    // (`VAULT_ROLE_ID` / `VAULT_SECRET_ID`); whenever an `admin` session
    // is created the `databaseHooks.session.create.before` hook above
    // exchanges those AppRole credentials for a manager-scoped
    // `vault_token` and stashes it on the session row so subsequent
    // calls authenticate via the session cookie alone (see
    // `src/auth/auth.guard.ts`).
    admin({
      defaultRole: 'user',
      adminRoles: ['admin'],
      impersonationSessionDuration: 60 * 60, // 1 hour
    }),
    openAPI(),
  ],
});
