import {
  amazonCodes,
  parseJson,
  REGION_SETTINGS,
  SpApiError,
  SpApiErrorStatistics,
  type HttpInput,
  type HttpResponse,
  type Region,
  type Transport,
} from '@asin-monitor/sp-api';

/** Statistics belong to actual attempts at the two SP-API origins. LWA/HTML,
 * preflight failures, queue waits and logical business checks are different units.
 */
export class ObservedSpApiTransport implements Transport {
  constructor(
    private readonly transport: Transport,
    private readonly errors: SpApiErrorStatistics,
  ) {}
  private record(error: unknown, input: HttpInput, region: Region): void {
    if (input.signal.aborted) {
      if (
        !(input.signal.reason instanceof SpApiError) ||
        input.signal.reason.code !== 'TIMEOUT'
      )
        return;
      error = new SpApiError('TIMEOUT');
    }
    if (
      error instanceof SpApiError &&
      [
        'CANCELLED',
        'CLOSED',
        'CAPACITY',
        'INVALID_INPUT',
        'INVALID_CONFIG',
      ].includes(error.code)
    )
      return;
    this.errors.recordErrorAuto(error, region);
  }
  async request(input: HttpInput): Promise<HttpResponse> {
    const region = (['US', 'EU'] as const).find(
      (value) => input.url.origin === REGION_SETTINGS[value].endpoint,
    );
    if (!region) return this.transport.request(input);
    let response: HttpResponse;
    try {
      response = await this.transport.request(input);
    } catch (error) {
      this.record(error, input, region);
      throw error;
    }
    if (input.signal.aborted)
      this.record(new SpApiError('CANCELLED'), input, region);
    else if (response.statusCode < 200 || response.statusCode >= 300)
      this.record(
        new SpApiError(
          'HTTP_ERROR',
          response.statusCode,
          amazonCodes(response.body),
        ),
        input,
        region,
      );
    else if (response.body && parseJson(response.body) === undefined)
      this.record(new SpApiError('INVALID_RESPONSE'), input, region);
    return response;
  }
}
