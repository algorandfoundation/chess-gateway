import { Body, Controller, Param, Post, Put, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthUserService } from './auth-user.service';
import { Public } from './constants';
import { SignInRequestDto, SignInResponseDto } from './sign-in.dto';
import {
  AuthUserResponseDto,
  CreateAuthUserDto,
  UpdateAuthUserDto,
} from './auth-user.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@Controller()
export class Auth {
  constructor(
    private readonly authService: AuthService,
    private readonly authUserService: AuthUserService,
  ) {}

  @Public()
  @Post('auth/sign-in/')
  @ApiOperation({
    summary: 'Sign In',
    description: 'Endpoint to sign in with a `vault_token`',
  })
  @ApiCreatedResponse({
    description: 'The access token has been successfully created.',
    type: SignInResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async signIn(@Body() signInParams: SignInRequestDto) {
    const signInResponse: SignInResponseDto = await this.authService.signIn(signInParams.vault_token);

    return signInResponse;
  }

  /**
   * Provision a new Intermezzo Better-Auth user end-to-end:
   * Better-Auth row + vault transit key + link verification mapping.
   *
   * Authenticated by the regular JWT — the embedded `vault_token`
   * must be the manager-scoped one (issued via `signInWithRole` on
   * the manager AppRole) because we use it to mint the transit key.
   */
  @ApiBearerAuth()
  @Post('auth/user')
  @ApiOperation({
    summary: 'Create Intermezzo user',
    description:
      'Creates a Better-Auth user, provisions their vault wallet, and writes the link-verification document used by future device-link flows.',
  })
  @ApiCreatedResponse({ type: AuthUserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async createUser(
    @Request() request: any,
    @Body() body: CreateAuthUserDto,
  ): Promise<AuthUserResponseDto> {
    return this.authUserService.createUser(body, request.vault_token);
  }

  /**
   * Update an existing Intermezzo Better-Auth user. Supports
   * email/name edits, role changes (incl. promoting to `manager`),
   * and re-binding to a different vault transit key.
   */
  @ApiBearerAuth()
  @Put('auth/user/:userId')
  @ApiOperation({
    summary: 'Update Intermezzo user',
    description:
      'Update Better-Auth profile fields, role, and/or the vault transit key the user is bound to.',
  })
  @ApiOkResponse({ type: AuthUserResponseDto })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async updateUser(
    @Request() request: any,
    @Param('userId') userId: string,
    @Body() body: UpdateAuthUserDto,
  ): Promise<AuthUserResponseDto> {
    return this.authUserService.updateUser(userId, body, request.vault_token);
  }
}
