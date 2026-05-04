import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { emailOTP, openAPI } from 'better-auth/plugins';
import { Kysely, SqliteDialect } from 'kysely';
import SQLite from 'better-sqlite3';
import * as path from 'path';

const db = new Kysely({
  dialect: new SqliteDialect({
    database: new SQLite(path.join(process.cwd(), 'database.sqlite')),
  }),
});

const baseAdapter = kyselyAdapter(db as any, {
  type: 'sqlite',
});

const wrapAdapter = (adapter: any) => {
  if (typeof adapter === 'function') {
    return (options: any) => wrapAdapter(adapter(options));
  }

  const transform = (res: any) => {
    if (!res || typeof res !== 'object') return res;
    if (Array.isArray(res)) return res.map(transform);
    const transformed = { ...res };
    [
      'expiresAt',
      'createdAt',
      'updatedAt',
      'emailVerifiedDate',
      'joinedAt',
      'accessTokenExpiresAt',
      'refreshTokenExpiresAt',
    ].forEach((key) => {
      if (transformed[key] && typeof transformed[key] === 'string') {
        transformed[key] = new Date(transformed[key]);
      }
    });
    return transformed;
  };

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return async (...args: any[]) => {
          // Fix missing ID for create
          if (prop === 'create' && args[0] && args[0].data && !args[0].data.id) {
            args[0].data.id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
          }

          try {
            const result = await value.apply(target, args);

            // Fallback for create returning null
            if (prop === 'create' && result === null && args[0] && args[0].data && args[0].data.id) {
              const { model, data } = args[0];
              const found = await adapter.findOne({ model, where: [{ field: 'id', value: data.id }] });
              if (found) return transform(found);
              return transform(data);
            }

            return transform(result);
          } catch (e) {
            throw e;
          }
        };
      }
      return value;
    },
  });
};

console.log('[Auth] Initializing Better Auth instance...');

export const auth = betterAuth({
  database: wrapAdapter(baseAdapter),
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
