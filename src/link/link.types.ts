import { UserSession } from '@thallesp/nestjs-better-auth';
import { auth } from './auth';

type BaseUserSession = UserSession<typeof auth>;

export type LinkSession = Omit<BaseUserSession, 'session'> & {
  session: BaseUserSession['session'] & { challenge?: string; vaultToken?: string };
};
