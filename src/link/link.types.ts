import { UserSession } from '@thallesp/nestjs-better-auth';
import { auth } from './auth';

export type LinkSession = UserSession<typeof auth> & { challenge?: string };
