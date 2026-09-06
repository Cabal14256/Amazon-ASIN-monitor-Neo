import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * 指标命名沿用旧系统 metricsService.js 的 amazon_asin_monitor_* 前缀，
 * 保证 Grafana 看板无缝切换（总体计划 §3.5）。
 */
export const METRICS_PREFIX = 'amazon_asin_monitor_';
const RATE_LIMIT_BACKENDS = ['disabled', 'memory', 'redis'] as const;
type RateLimitBackendState = (typeof RATE_LIMIT_BACKENDS)[number];

@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly registry = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: `${METRICS_PREFIX}http_requests_total`,
    help: 'HTTP 请求总数',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  readonly httpRequestDurationSeconds = new Histogram({
    name: `${METRICS_PREFIX}http_request_duration_seconds`,
    help: 'HTTP 请求耗时（秒）',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly variantGroupChecksTotal = new Counter({
    name: `${METRICS_PREFIX}variant_group_checks_total`,
    help: '变体组检查总数（P2 阶段接入）',
    labelNames: ['region', 'result'] as const,
    registers: [this.registry],
  });

  readonly variantGroupCheckDurationSeconds = new Histogram({
    name: `${METRICS_PREFIX}variant_group_check_duration_seconds`,
    help: '每次变体组监控耗时',
    labelNames: ['region'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly schedulerRunsTotal = new Counter({
    name: `${METRICS_PREFIX}scheduler_runs_total`,
    help: '调度任务执行总数（P2 阶段接入）',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly schedulerRunDurationSeconds = new Histogram({
    name: `${METRICS_PREFIX}scheduler_run_duration_seconds`,
    help: '调度任务执行耗时',
    labelNames: ['type'] as const,
    buckets: [1, 5, 10, 30, 60, 120],
    registers: [this.registry],
  });

  readonly dbQueryDurationSeconds = new Histogram({
    name: `${METRICS_PREFIX}db_query_duration_seconds`,
    help: '数据库查询耗时（秒，P2 阶段接入）',
    labelNames: ['table', 'operation'] as const,
    buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly dbQueriesTotal = new Counter({
    name: `${METRICS_PREFIX}db_queries_total`,
    help: '数据库查询总数',
    labelNames: ['table', 'operation', 'status'] as const,
    registers: [this.registry],
  });

  readonly cacheHitsTotal = new Counter({
    name: `${METRICS_PREFIX}cache_hits_total`,
    help: '缓存命中总数（P2 阶段接入）',
    labelNames: ['cache_key_prefix'] as const,
    registers: [this.registry],
  });

  readonly cacheMissesTotal = new Counter({
    name: `${METRICS_PREFIX}cache_misses_total`,
    help: '缓存未命中次数（P2 阶段接入）',
    labelNames: ['cache_key_prefix'] as const,
    registers: [this.registry],
  });

  readonly healthDependencyUp = new Gauge({
    name: `${METRICS_PREFIX}health_dependency_up`,
    help: '健康探针依赖是否可用（1=可用，0=不可用）',
    labelNames: ['dependency'] as const,
    registers: [this.registry],
  });

  readonly healthProbeDurationSeconds = new Histogram({
    name: `${METRICS_PREFIX}health_probe_duration_seconds`,
    help: '健康探针耗时（秒）',
    labelNames: ['dependency'] as const,
    buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly httpRateLimitDecisionsTotal = new Counter({
    name: `${METRICS_PREFIX}http_rate_limit_decisions_total`,
    help: 'HTTP 限流允许与阻断决策总数',
    labelNames: ['role', 'policy', 'outcome', 'backend'] as const,
    registers: [this.registry],
  });

  readonly httpRateLimitBackendActive = new Gauge({
    name: `${METRICS_PREFIX}http_rate_limit_backend_active`,
    help: 'HTTP 限流当前后端（当前后端为 1，其余为 0）',
    labelNames: ['backend'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ prefix: METRICS_PREFIX, register: this.registry });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  recordHealthProbe(input: {
    dependency: 'competitor_database' | 'database' | 'redis';
    up: boolean;
    durationSeconds: number;
  }): void {
    const labels = { dependency: input.dependency };
    this.healthDependencyUp.set(labels, input.up ? 1 : 0);
    this.healthProbeDurationSeconds.observe(labels, input.durationSeconds);
  }

  recordRateLimitDecision(input: {
    role: 'ADMIN' | 'DEFAULT' | 'EDITOR' | 'READONLY';
    policy: 'role' | 'strict';
    outcome: 'allowed' | 'blocked';
    backend: 'memory' | 'redis';
  }): void {
    this.httpRateLimitDecisionsTotal.inc(input);
  }

  setRateLimitBackend(backend: RateLimitBackendState): void {
    for (const candidate of RATE_LIMIT_BACKENDS) {
      this.httpRateLimitBackendActive.set(
        { backend: candidate },
        candidate === backend ? 1 : 0,
      );
    }
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }
}
