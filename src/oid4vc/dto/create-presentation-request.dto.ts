import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class CreatePresentationRequestDto {
  @ApiProperty({
    description: 'DIF Presentation Definition v2. The wallet will be asked to satisfy this definition.',
    example: {
      id: 'rewards-eligibility',
      input_descriptors: [
        {
          id: 'credential-sd-jwt',
          format: { 'vc+sd-jwt': { 'sd-jwt_alg_values': ['EdDSA'] } },
          constraints: {
            fields: [{ path: ['$.vct'], filter: { type: 'string', const: 'credential-sd-jwt' } }],
          },
        },
      ],
    },
  })
  @IsObject()
  presentationDefinition!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Application user the verification is created for. Stored on the verification session.',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}

export class PresentationRequestResponseDto {
  @ApiProperty({ description: 'Local verification session id.' })
  id!: string;

  @ApiProperty({ description: 'Id of the underlying Credo OpenId4VcVerificationSessionRecord.' })
  credoVerificationSessionId!: string;

  @ApiProperty({
    description: 'Authorization request URI (`openid4vp://...` or `openid://...`). Render this as a QR code.',
  })
  authorizationRequest!: string;

  @ApiProperty({ description: 'Current state of the Credo verification session.' })
  state!: string;
}
