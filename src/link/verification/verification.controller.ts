import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { CreateLinkVerificationDto, UpdateLinkVerificationDto } from './verification.dto';

@ApiTags('Verification')
@Controller('link/verifications')
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  /**
   * Retrieves all link verifications.
   * This endpoint uses the global JWT auth guard (same as wallet endpoints).
   */
  @Get()
  @ApiOperation({ summary: 'Get all link verifications' })
  @ApiResponse({ status: 200, description: 'Verifications retrieved successfully.' })
  @ApiBearerAuth()
  async findAll() {
    return this.verificationService.findAll();
  }

  /**
   * Retrieves a specific link verification by ID.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a link verification by ID' })
  @ApiResponse({ status: 200, description: 'Verification retrieved successfully.' })
  @ApiResponse({ status: 404, description: 'Verification not found.' })
  @ApiBearerAuth()
  async findOne(@Param('id') id: string) {
    return this.verificationService.findOne(id);
  }

  /**
   * Creates a new link verification.
   */
  @Post()
  @ApiOperation({ summary: 'Create a new link verification' })
  @ApiBody({ type: CreateLinkVerificationDto })
  @ApiResponse({ status: 201, description: 'Verification created successfully.' })
  @ApiBearerAuth()
  async create(@Body() body: CreateLinkVerificationDto) {
    return this.verificationService.create(body);
  }

  /**
   * Updates a link verification by ID.
   */
  @Put(':id')
  @ApiOperation({ summary: 'Update a link verification' })
  @ApiBody({ type: UpdateLinkVerificationDto })
  @ApiResponse({ status: 200, description: 'Verification updated successfully.' })
  @ApiResponse({ status: 404, description: 'Verification not found.' })
  @ApiBearerAuth()
  async update(@Param('id') id: string, @Body() body: UpdateLinkVerificationDto) {
    return this.verificationService.update(id, body);
  }

  /**
   * Deletes a link verification by ID.
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a link verification' })
  @ApiResponse({ status: 200, description: 'Verification deleted successfully.' })
  @ApiResponse({ status: 404, description: 'Verification not found.' })
  @ApiBearerAuth()
  async remove(@Param('id') id: string) {
    return this.verificationService.remove(id);
  }
}
