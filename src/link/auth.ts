import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { admin, emailOTP, openAPI } from 'better-auth/plugins';
import { Kysely, SqliteDialect } from 'kysely';
import SQLite from 'better-sqlite3';
import * as path from 'path';

export const db = new Kysely({
  dialect: new SqliteDialect({
    database: new SQLite(path.join(process.cwd(), 'database.sqlite')),
  }),
});

console.log('[Auth] Initializing Better Auth instance...');

export const auth = betterAuth({
  database: {
    db: db,
    type: 'sqlite',
  },
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  basePath: '/v1/link/auth',
  trustedOrigins: [process.env.BETTER_AUTH_URL].filter(Boolean) as string[],
  secret: process.env.BETTER_AUTH_SECRET || 'a-very-long-and-secure-secret-32-chars!!',
  advanced: {
    disableOriginCheck: true,
    disableCSRFCheck: true,
  },
  emailAndPassword: {
    enabled: true,
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
    admin({
      defaultRole: 'user',
      adminRoles: ['admin'],
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        console.log(`[OTP] To: ${email}, OTP: ${otp}, Type: ${type}`);
      },
      expiresIn: 3600,
      storeOTP: 'plain',
    }),
    openAPI(),
  ],
});
