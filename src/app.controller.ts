import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { Public } from './auth/constants';
import { HealthResponseDto, HealthService } from './health.service';

/**
 * Top-level controller for service-wide concerns that don't belong to
 * any single feature module (currently just the aggregate health probe
 * consumed by the manager debug page and external monitors).
 */
@Controller()
export class AppController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Aggregate health/status probe for the gateway and its hard
   * dependencies (Vault, the Algorand node, and the local sqlite
   * database backing TypeORM + Better-Auth). Public so callers don't
   * need a JWT to monitor the service. Always returns 200 — inspect
   * `status` and per-service `ok` to tell ok from degraded.
   */
  @Public()
  @Get('health')
  @ApiOperation({
    summary: 'Service health',
    description:
      'Lists the status of every service the gateway depends on (Vault, Algorand node, sqlite database). Always returns 200; inspect the `status` and per-service `ok` flags.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  async health(): Promise<HealthResponseDto> {
    return this.healthService.check();
  }
}
