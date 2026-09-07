import { SpApiError } from './errors';
import {
  HourlyCounter,
  safeCount,
  TelemetryClock,
  validateWindow,
} from './telemetry-window';
import type { Logger } from './types';

export const SP_API_RISK_POLICY = Object.freeze({
  checks: 100,
  calculationWindow: 50,
  responseTimes: 1000,
  errorRateThreshold: 0.3,
  rateLimitThreshold: 5,
  lowErrorRateThreshold: 0.1,
  fastResponseSeconds: 2,
  adjustmentStep: 1,
  minConcurrency: 1,
  defaultMaxConcurrency: 10,
  cooldownMs: 300_000,
});
export interface SpApiCheckResult {
  success?: boolean;
  isRateLimit?: boolean;
  isSpApiError?: boolean;
  responseTime?: number;
}
export class SpApiRiskController {
  private readonly clock: TelemetryClock;
  private readonly rateLimits = new HourlyCounter();
  private checks: Required<SpApiCheckResult>[] = [];
  private responseTimes: number[] = [];
  private totalRateLimitErrors = 0;
  private totalSpApiErrors = 0;
  private totalSuccessfulChecks = 0;
  private lastRateLimitAt: number | null = null;
  private lastAdjustmentAt: number | null = null;
  private currentConcurrency = 1;
  private readonly maxConcurrency: number;
  constructor(
    private readonly options: {
      logger: Logger;
      now?: () => number;
      maxConcurrency?: number;
    },
  ) {
    this.maxConcurrency =
      options?.maxConcurrency ?? SP_API_RISK_POLICY.defaultMaxConcurrency;
    if (
      typeof options?.logger?.info !== 'function' ||
      !Number.isInteger(this.maxConcurrency) ||
      this.maxConcurrency < 1 ||
      this.maxConcurrency > 1000
    )
      throw new SpApiError('INVALID_CONFIG');
    this.clock = new TelemetryClock(options.now);
  }
  recordCheck(input: SpApiCheckResult) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new SpApiError('INVALID_INPUT');
    const {
      success = false,
      isRateLimit = false,
      isSpApiError = false,
      responseTime = 0,
    } = input;
    if (
      [success, isRateLimit, isSpApiError].some(
        (value) => typeof value !== 'boolean',
      ) ||
      !Number.isFinite(responseTime) ||
      responseTime < 0 ||
      responseTime > 86400
    )
      throw new SpApiError('INVALID_INPUT');
    const now = this.clock.now();
    this.checks.push({ success, isRateLimit, isSpApiError, responseTime });
    if (this.checks.length > SP_API_RISK_POLICY.checks) this.checks.shift();
    if (isRateLimit) {
      this.totalRateLimitErrors = safeCount(this.totalRateLimitErrors);
      this.lastRateLimitAt = now;
      this.rateLimits.record(now);
    }
    if (isSpApiError) this.totalSpApiErrors = safeCount(this.totalSpApiErrors);
    if (success && !isRateLimit && !isSpApiError)
      this.totalSuccessfulChecks = safeCount(this.totalSuccessfulChecks);
    if (responseTime > 0) {
      this.responseTimes.push(responseTime);
      if (this.responseTimes.length > SP_API_RISK_POLICY.responseTimes)
        this.responseTimes.shift();
    }
  }
  getRecentErrorRate(
    windowSize: number = SP_API_RISK_POLICY.calculationWindow,
  ) {
    validateWindow(windowSize, SP_API_RISK_POLICY.checks);
    const recent = this.checks.slice(-windowSize);
    return recent.length
      ? recent.filter(
          (row) => !row.success || row.isRateLimit || row.isSpApiError,
        ).length / recent.length
      : 0;
  }
  getRecentRateLimitCount() {
    return this.rateLimits.count(this.clock.now());
  }
  getAverageResponseTime(
    windowSize: number = SP_API_RISK_POLICY.calculationWindow,
  ) {
    validateWindow(windowSize, SP_API_RISK_POLICY.responseTimes);
    const recent = this.responseTimes.slice(-windowSize);
    return recent.length
      ? recent.reduce((sum, time) => sum + time, 0) / recent.length
      : 0;
  }
  private concurrency(value: number) {
    if (!Number.isFinite(value) || value <= 0)
      throw new SpApiError('INVALID_INPUT');
    return Math.min(
      this.maxConcurrency,
      Math.max(SP_API_RISK_POLICY.minConcurrency, Math.floor(value)),
    );
  }
  setCurrentConcurrency(value: number) {
    this.currentConcurrency = this.concurrency(value);
  }
  calculateOptimalConcurrency(value = this.currentConcurrency) {
    const current = this.concurrency(value),
      now = this.clock.now();
    if (
      !this.checks.length ||
      (this.lastAdjustmentAt !== null &&
        now - this.lastAdjustmentAt < SP_API_RISK_POLICY.cooldownMs)
    )
      return current;
    const errorRate = this.getRecentErrorRate(),
      rateLimits = this.getRecentRateLimitCount(),
      responseTime = this.getAverageResponseTime();
    let next = current;
    if (
      errorRate > SP_API_RISK_POLICY.errorRateThreshold ||
      rateLimits > SP_API_RISK_POLICY.rateLimitThreshold
    )
      next = Math.max(
        SP_API_RISK_POLICY.minConcurrency,
        current - SP_API_RISK_POLICY.adjustmentStep,
      );
    else if (
      errorRate < SP_API_RISK_POLICY.lowErrorRateThreshold &&
      rateLimits === 0 &&
      responseTime < SP_API_RISK_POLICY.fastResponseSeconds
    )
      next = Math.min(
        this.maxConcurrency,
        current + SP_API_RISK_POLICY.adjustmentStep,
      );
    if (next !== current) {
      this.lastAdjustmentAt = now;
      this.options.logger.info('SP-API 检查并发调整', {
        previous: current,
        next,
        reason: next < current ? 'error_or_throttle' : 'healthy_checks',
      });
    }
    this.currentConcurrency = next;
    return next;
  }
  getMetrics() {
    return {
      errorRate: this.getRecentErrorRate().toFixed(3),
      rateLimitCount: this.getRecentRateLimitCount(),
      avgResponseTime: this.getAverageResponseTime().toFixed(2),
      recentChecksCount: this.checks.length,
      totalRateLimitErrors: this.totalRateLimitErrors,
      totalSpApiErrors: this.totalSpApiErrors,
      totalSuccessfulChecks: this.totalSuccessfulChecks,
      lastRateLimitAt: this.lastRateLimitAt,
    };
  }
  resetMetrics() {
    this.checks = [];
    this.responseTimes = [];
    this.rateLimits.reset();
    this.totalRateLimitErrors = 0;
    this.totalSpApiErrors = 0;
    this.totalSuccessfulChecks = 0;
    this.lastRateLimitAt = null;
    this.lastAdjustmentAt = null;
    this.options.logger.info('SP-API 风险指标已重置');
  }
}
