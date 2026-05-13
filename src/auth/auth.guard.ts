import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './constants';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../link/auth';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    private configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // Preferred path: a gateway-issued Bearer JWT carrying a vault
    // token (machine/service callers, plus humans who explicitly
    // exchanged a vault token via `POST /auth/token`).
    const token = this.extractTokenFromHeader(request);
    if (token) {
      try {
        const payload = await this.jwtService.verifyAsync(token, {
          secret: this.configService.get<string>('JWT_SECRET'),
        });
        (request as any)['vault_token'] = payload.vault_token;
        return true;
      } catch {
        // Fall through to the Better-Auth session check below — a
        // human manager logging in via OTP will arrive here without
        // a Bearer JWT but with a Better-Auth session cookie.
      }
    }

    // Fallback path: a Better-Auth session whose `vaultToken` field
    // has been populated by the `databaseHooks.session.create.before`
    // hook in `src/link/auth.ts`. Admin sessions carry a
    // manager-scoped token minted from `VAULT_ROLE_ID` /
    // `VAULT_SECRET_ID`; regular user sessions carry a user-scoped
    // token minted from `USER_VAULT_ROLE_ID` /
    // `USER_VAULT_SECRET_ID`. In both cases the AppRole secret never
    // leaves the gateway; only the issued `client_token` rides on
    // the session row.
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      const vaultToken = (session?.session as { vaultToken?: string } | undefined)?.vaultToken;
      if (session && vaultToken) {
        (request as any)['vault_token'] = vaultToken;
        return true;
      }
    } catch {
      // Treat any session lookup failure as unauthenticated.
    }

    throw new UnauthorizedException();
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
