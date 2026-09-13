import type { MonitorAnalyticsOperation } from '@asin-monitor/db';
import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MonitorAnalyticsGuard } from './monitor-analytics.guard';
import { MonitorAnalyticsService } from './monitor-analytics.service';

@Controller('monitor-history')
@UseGuards(MonitorAnalyticsGuard)
export class MonitorAnalyticsController {
  constructor(
    @Inject(MonitorAnalyticsService)
    private readonly service: MonitorAnalyticsService,
  ) {}
  private async respond(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: MonitorAnalyticsOperation,
  ) {
    reply.header('Cache-Control', 'no-store');
    // Current permissions are checked inside the database transaction for every
    // route, including cache hits; two Legacy routes accept either read grant.
    const encoded = await this.service.read(
      request.auth!,
      reply,
      operation,
      request.query,
      request.headers['x-analytics-cache-bypass'],
    );
    return reply.type('application/json; charset=utf-8').send(encoded);
  }
  @Get('statistics')
  statistics(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'statistics');
  }
  @Get('statistics/by-time')
  byTime(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'by-time');
  }
  @Get('statistics/by-country')
  byCountry(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'by-country');
  }
  @Get('statistics/by-variant-group')
  byVariantGroup(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'by-variant-group');
  }
  @Get('statistics/peak-hours')
  peakHours(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'peak-hours');
  }
  @Get('statistics/analytics-monthly-breakdown')
  monthlyBreakdown(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'analytics-monthly-breakdown');
  }
  @Get('statistics/peak-mark-areas')
  peakMarkAreas(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'peak-mark-areas');
  }
  @Get('statistics/all-countries-summary')
  allCountries(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'all-countries-summary');
  }
  @Get('statistics/region-summary')
  regions(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'region-summary');
  }
  @Get('statistics/period-summary')
  periods(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'period-summary');
  }
  @Get('statistics/period-summary/details')
  periodDetails(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'period-summary/details');
  }
  @Get('statistics/asin-by-country')
  asinByCountry(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'asin-by-country');
  }
  @Get('statistics/asin-by-variant-group')
  asinByVariantGroup(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.respond(request, reply, 'asin-by-variant-group');
  }
  @Get('abnormal-duration-statistics')
  abnormalDuration(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(request, reply, 'abnormal-duration-statistics');
  }
}
