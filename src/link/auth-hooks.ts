/**
 * Bridge between Better Auth's static `databaseHooks` and the Nest
 * runtime DI graph. The `auth` instance is constructed at module load
 * time (it has to be, to satisfy `auth.handler` mounted on the HTTP
 * server) so it cannot reach into Nest providers directly.
 *
 * Instead, Nest modules register a callback here from
 * `OnModuleInit`, and the `databaseHooks.user.create.after` invokes
 * whatever is registered. When no handler is registered (e.g. during
 * tests) the hook is a no-op.
 */

export interface BetterAuthCreatedUser {
  id: string;
  email: string;
  name?: string;
  role?: string;
  [key: string]: unknown;
}

export type UserCreatedHandler = (user: BetterAuthCreatedUser) => Promise<void> | void;

let registeredHandler: UserCreatedHandler | null = null;

/**
 * Register the post-create handler. Called once from
 * `AuthModule.onModuleInit` so the handler can resolve Nest providers
 * (WalletService, VerificationService, …).
 */
export function registerUserCreatedHandler(handler: UserCreatedHandler): void {
  registeredHandler = handler;
}

/**
 * Invoked from Better Auth's `databaseHooks.user.create.after`.
 * Errors are caught and logged so a failure to provision the vault
 * mapping does not abort the user-creation request — managers can
 * always rerun the association via `PUT /auth/user/:userId`.
 */
export async function dispatchUserCreated(user: BetterAuthCreatedUser): Promise<void> {
  if (!registeredHandler) {
    console.warn(
      `[Auth] user.create hook fired for ${user?.email ?? user?.id} but no handler is registered yet.`,
    );
    return;
  }
  try {
    await registeredHandler(user);
  } catch (error: any) {
    console.error(
      `[Auth] user.create hook failed for ${user?.email ?? user?.id}: ${error?.message ?? error}`,
    );
  }
}
