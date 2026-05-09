import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { admin, emailOTP, openAPI } from 'better-auth/plugins';
import SQLite from 'better-sqlite3';
import * as path from 'path';

console.log('[Auth] Initializing Better Auth instance...');

export const auth = betterAuth({
  // Pass the better-sqlite3 Database directly so Better Auth manages the
  // schema (and `npx @better-auth/cli migrate` works) instead of us
  // wrapping a Kysely adapter by hand.
  database: new SQLite(path.join(process.cwd(), 'database.sqlite')),
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  basePath: '/v1/link/auth',
  trustedOrigins: [process.env.BETTER_AUTH_URL].filter(Boolean) as string[],
  secret: process.env.BETTER_AUTH_SECRET || 'a-very-long-and-secure-secret-32-chars!!',
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
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || 'mock-id',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'mock-secret',
    },
  },
  plugins: [
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        console.log(`[OTP] To: ${email}, OTP: ${otp}, Type: ${type}`);
      },
      expiresIn: 3600,
      storeOTP: 'plain',
    }),
    // Admin plugin gives us role-based access (`user` / `manager` /
    // `admin`) plus the impersonation endpoints the manager UI uses
    // to act on behalf of an Intermezzo user. The default `admin` role
    // remains the highest privilege; `manager` is added so vault-
    // managers can be promoted without granting full admin powers.
    admin({
      defaultRole: 'user',
      adminRoles: ['admin'],
      impersonationSessionDuration: 60 * 60, // 1 hour
    }),
    openAPI(),
  ],
});
