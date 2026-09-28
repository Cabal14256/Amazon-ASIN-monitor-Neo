import type {
  CompetitorAsin,
  CompetitorCheckObservation,
  CompetitorCheckRepositoryPort,
  CompetitorCheckUnit,
  CompetitorVariantGroup,
} from '@asin-monitor/db';
import {
  catalogNotFoundResult,
  type CatalogVariantResult,
} from '@asin-monitor/sp-api';
import { CompetitorCheckPipeline } from '@asin-monitor/variant-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const before = new Date('2026-01-01T00:00:00.000Z');
const checkedAt = new Date('2026-09-12T00:00:00.000Z');
type History = {
  variantGroupId?: string;
  variantGroupName?: string;
  asinId?: string;
  asinCode?: string;
  asinName?: string;
  checkType: string;
  country?: string;
  checkResult: unknown;
  isBroken: number | boolean;
  checkTime?: Date;
};

function fixture() {
  const group: CompetitorVariantGroup = {
    id: 'g1',
    name: 'Fixture group',
    country: 'US',
    brand: 'Fixture',
    isBroken: false,
    variantStatus: 'NORMAL',
    feishuNotifyEnabled: false,
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
  };
  const children: CompetitorAsin[] = [1, 2].map((index) => ({
    id: `a${index}`,
    asin: `B00000000${index}`,
    name: `Product ${index}`,
    asinType: index === 1 ? 'MAIN_LINK' : 'SUB_REVIEW',
    country: 'US',
    brand: 'Fixture',
    variantGroupId: group.id,
    isBroken: false,
    variantStatus: 'NORMAL',
    feishuNotifyEnabled: false,
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
  }));
  const checked = (asin: string): CatalogVariantResult => ({
    hasVariants: true,
    variantCount: 1,
    details: {
      asin,
      country: 'US',
      title: 'Fixture title',
      brand: 'Fixture',
      parentAsin: 'B000000099',
      variations: [],
      relationships: [],
    },
    meta: { source: 'spapi', apiVersion: '2022-04-01' },
  });
  const results = new Map<string, CatalogVariantResult | Error>([
    [children[0].asin, checked(children[0].asin)],
    [children[1].asin, checked(children[1].asin)],
  ]);
  const check = vi.fn(async (asin: string) => {
    const value = results.get(asin);
    if (value instanceof Error) throw value;
    if (!value) throw new Error('Unexpected ASIN');
    return value;
  });
  return { group, children, results, check };
}

function legacy(f: ReturnType<typeof fixture>) {
  const group = structuredClone(f.group);
  const children = structuredClone(f.children);
  const history: History[] = [];
  const rawGroup = () => ({
    id: group.id,
    name: group.name,
    country: group.country,
    brand: group.brand,
    is_broken: group.isBroken ? 1 : 0,
    variant_status: group.variantStatus,
    feishu_notify_enabled: group.feishuNotifyEnabled ? 1 : 0,
    create_time: group.createTime,
    update_time: group.updateTime,
    last_check_time: group.lastCheckTime,
  });
  const rawAsin = (row: CompetitorAsin) => ({
    id: row.id,
    asin: row.asin,
    name: row.name,
    asin_type: row.asinType,
    country: row.country,
    brand: row.brand,
    variant_group_id: row.variantGroupId,
    is_broken: row.isBroken ? 1 : 0,
    variant_status: row.variantStatus,
    create_time: row.createTime,
    update_time: row.updateTime,
    last_check_time: row.lastCheckTime,
    feishu_notify_enabled: row.feishuNotifyEnabled ? 1 : 0,
  });
  const query = async (statement: string, values: unknown[] = []) => {
    if (statement.includes('SELECT * FROM competitor_variant_groups'))
      return group.id === values[0] ? [rawGroup()] : [];
    if (statement.includes('FROM competitor_asins WHERE variant_group_id'))
      return children
        .filter((row) => row.variantGroupId === values[0])
        .map(rawAsin);
    if (statement.includes('FROM competitor_asins WHERE id =')) {
      const row = children.find((item) => item.id === values[0]);
      return row ? [rawAsin(row)] : [];
    }
    if (statement.includes('UPDATE competitor_asins')) {
      const row = children.find((item) => item.id === values[2]);
      if (!row) throw new Error('Unexpected Legacy ASIN update');
      row.isBroken = Boolean(values[0]);
      row.variantStatus = row.isBroken ? 'BROKEN' : 'NORMAL';
      row.lastCheckTime = checkedAt;
      return [];
    }
    if (statement.includes('UPDATE competitor_variant_groups')) {
      group.isBroken = Boolean(values[0]);
      group.variantStatus = group.isBroken ? 'BROKEN' : 'NORMAL';
      if (statement.includes('last_check_time'))
        group.lastCheckTime = checkedAt;
      return [];
    }
    throw new Error(`Unexpected Legacy model query: ${statement}`);
  };
  const withTransaction = async <T>(
    action: (unit: { query: typeof query }) => Promise<T>,
  ) => action({ query });
  const modelDeps = {
    '../config/competitor-database': { query, withTransaction },
    uuid: { v4: () => 'fixture-id' },
    '../services/cacheService': {
      getAsync: async () => null,
      setAsync: async () => undefined,
      deleteByPrefix: () => undefined,
      deleteByPrefixAsync: async () => undefined,
    },
    '../utils/logger': { debug() {}, info() {}, warn() {}, error() {} },
  };
  const loadModel = <T>(
    path: string,
    dependencies: Record<string, unknown>,
  ) => {
    const filename = resolve(__dirname, `../../../server/src/${path}`);
    const module = { exports: {} as T };
    vm.runInNewContext(
      readFileSync(filename, 'utf8'),
      {
        module,
        exports: module.exports,
        process: { env: { NODE_ENV: 'test' } },
        require: (name: string) => {
          if (!Object.hasOwn(dependencies, name))
            throw new Error(`Unexpected Legacy model dependency: ${name}`);
          return dependencies[name];
        },
      },
      { filename },
    );
    return module.exports;
  };
  const groupModel = loadModel<{
    findById(id: string): Promise<Record<string, unknown> | null>;
    updateVariantStatus(id: string, broken: boolean): Promise<void>;
    updateVariantStatusAndCheckTime(id: string, broken: boolean): Promise<void>;
  }>('models/CompetitorVariantGroup.js', modelDeps);
  const asinModel = loadModel<{
    findById(id: string): Promise<Record<string, unknown> | null>;
    updateVariantStatusAndCheckTime(id: string, broken: boolean): Promise<void>;
  }>('models/CompetitorASIN.js', {
    ...modelDeps,
    './CompetitorVariantGroup': groupModel,
  });
  const cache = {
    getAsync: async () => null,
    setAsync: async () => undefined,
  };
  const noop = () => undefined;
  const module = {
    exports: {} as {
      checkSingleCompetitorASIN(
        id: string,
        forceRefresh: boolean,
      ): Promise<unknown>;
      checkCompetitorVariantGroup(
        id: string,
        forceRefresh: boolean,
      ): Promise<unknown>;
    },
  };
  const dependencies: Record<string, unknown> = {
    '../config/sp-api': { callSPAPI: noop, getMarketplaceId: noop },
    './legacySPAPIClient': { callLegacySPAPI: noop },
    '../models/CompetitorVariantGroup': groupModel,
    '../models/CompetitorASIN': asinModel,
    '../models/CompetitorMonitorHistory': {
      create: async (entry: History) => {
        history.push(structuredClone(entry));
      },
      bulkCreate: async (entries: History[]) => {
        history.push(...structuredClone(entries));
      },
    },
    './cacheService': cache,
    './htmlScraperService': {},
    '../models/SPAPIConfig': { findByKey: async () => null },
    '../utils/logger': { debug: noop, info: noop, warn: noop, error: noop },
    './variantCheckService': { checkASINVariants: f.check },
  };
  const filename = resolve(
    __dirname,
    '../../../server/src/services/competitorVariantCheckService.js',
  );
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      process: { env: { NODE_ENV: 'test' } },
      require: (name: string) => {
        if (!Object.hasOwn(dependencies, name))
          throw new Error(`Unexpected Legacy dependency: ${name}`);
        return dependencies[name];
      },
    },
    { filename },
  );
  return {
    history,
    group,
    children,
    checkSingle: (id: string) =>
      module.exports.checkSingleCompetitorASIN(id, true),
    checkGroup: (id: string) =>
      module.exports.checkCompetitorVariantGroup(id, true),
  };
}

function neo(f: ReturnType<typeof fixture>) {
  const group = structuredClone(f.group);
  const children = structuredClone(f.children);
  const history: History[] = [];
  const unit: CompetitorCheckUnit = {
    lockOperator: async () => undefined,
    lockSession: async () => undefined,
    operatorPermissionCodes: async () => [],
    readReceipt: async () => undefined,
    saveReceipt: async () => undefined,
    purgeExpiredReceipts: async () => 0,
    loadSingle: async (id) => {
      const asin = children.find((row) => row.id === id);
      if (!asin) throw new Error('Missing ASIN');
      return { group: structuredClone(group), asin: structuredClone(asin) };
    },
    loadGroup: async () => ({
      group: structuredClone(group),
      asins: structuredClone(children),
    }),
    commitSingle: async (snapshot, result, guard) => {
      await guard();
      const asin = children.find((row) => row.id === snapshot.asin.id)!;
      asin.isBroken = !result.hasVariants || result.variantCount === 0;
      asin.variantStatus = asin.isBroken ? 'BROKEN' : 'NORMAL';
      asin.lastCheckTime = checkedAt;
      group.isBroken = children.some((row) => row.isBroken);
      group.variantStatus = group.isBroken ? 'BROKEN' : 'NORMAL';
      history.push({
        variantGroupId: group.id,
        variantGroupName: group.name,
        asinId: asin.id,
        asinCode: asin.asin,
        asinName: asin.name ?? undefined,
        checkType: 'ASIN',
        country: asin.country,
        isBroken: asin.isBroken,
        checkResult: { asin: asin.asin, isBroken: asin.isBroken, result },
        checkTime: checkedAt,
      });
      return {
        asin: structuredClone(asin),
        group: structuredClone(group),
        result,
      };
    },
    commitGroup: async (_snapshot, observations, guard) => {
      await guard();
      const detailRows = observations.map(
        (item: CompetitorCheckObservation) => {
          const row = children.find((asin) => asin.id === item.asinId)!;
          const failed = item.kind === 'failed';
          row.isBroken =
            failed ||
            !item.result.hasVariants ||
            item.result.variantCount === 0;
          row.variantStatus = row.isBroken ? 'BROKEN' : 'NORMAL';
          row.lastCheckTime = checkedAt;
          return failed
            ? { asin: row.asin, error: item.error, errorType: 'SP_API_ERROR' }
            : {
                asin: row.asin,
                hasVariants: item.result.hasVariants,
                variantCount: item.result.variantCount,
                ...(item.result.errorType
                  ? { errorType: item.result.errorType }
                  : row.isBroken
                  ? { errorType: 'NO_VARIANTS' }
                  : {}),
              };
        },
      );
      group.isBroken = children.some((row) => row.isBroken);
      group.variantStatus = group.isBroken ? 'BROKEN' : 'NORMAL';
      group.lastCheckTime = checkedAt;
      const details = {
        totalASINs: children.length,
        brokenCount: children.filter((row) => row.isBroken).length,
        results: detailRows,
      };
      history.push({
        variantGroupId: group.id,
        variantGroupName: group.name,
        checkType: 'GROUP',
        country: group.country,
        isBroken: Boolean(group.isBroken),
        checkResult: details,
        checkTime: checkedAt,
      });
      for (const row of children)
        history.push({
          variantGroupId: group.id,
          variantGroupName: group.name,
          asinId: row.id,
          asinCode: row.asin,
          asinName: row.name ?? undefined,
          checkType: 'ASIN',
          country: row.country,
          isBroken: Boolean(row.isBroken),
          checkResult: { asin: row.asin, isBroken: Boolean(row.isBroken) },
          checkTime: checkedAt,
        });
      return {
        group: structuredClone(group),
        asins: structuredClone(children),
        observations,
      };
    },
  };
  const repository: CompetitorCheckRepositoryPort = {
    transaction: async (action) => action(unit),
  };
  const service = new CompetitorCheckPipeline(
    repository,
    { check: f.check },
    {
      claim: async () => 'fixture-claim',
      write: async () => undefined,
      invalidate: async () => undefined,
      clearDeferred: async () => undefined,
    },
    { info() {}, warn() {} },
  );
  const context = {
    forceRefresh: true,
    authorize: async () => undefined,
    checkpoint: async () => undefined,
  };
  return { service, history, group, children, context };
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const historyRows = (rows: History[]) =>
  rows.map((row) => ({
    variantGroupId: row.variantGroupId ?? null,
    variantGroupName: row.variantGroupName ?? null,
    asinId: row.asinId ?? null,
    asinCode: row.asinCode ?? null,
    asinName: row.asinName ?? null,
    checkType: row.checkType,
    country: row.country ?? null,
    isBroken: Boolean(row.isBroken),
    checkResult: plain(row.checkResult),
    checkTime: row.checkTime ? 'CHECKED' : null,
  }));
const groupResult = (value: unknown) => {
  const result = plain(value) as Record<string, unknown>;
  const group = result.groupSnapshot as Record<string, unknown>;
  return {
    isBroken: result.isBroken,
    brokenASINs: result.brokenASINs,
    brokenByType: result.brokenByType,
    details: result.details,
    group: {
      id: group.id,
      name: group.name,
      country: group.country,
      brand: group.brand,
      isBroken: Boolean(group.is_broken),
      variantStatus: group.variant_status,
      feishuNotifyEnabled: Number(
        group.feishu_notify_enabled ?? group.feishuNotifyEnabled,
      ),
      createTime: group.create_time ?? group.createTime,
      updateTime: group.update_time ?? group.updateTime,
      lastCheckTime: group.last_check_time ? 'CHECKED' : null,
      children: (group.children as Record<string, unknown>[]).map((row) => ({
        id: row.id,
        asin: row.asin,
        name: row.name,
        asinType: row.asinType,
        country: row.country,
        brand: row.brand,
        parentId: row.parentId,
        isBroken: Boolean(row.is_broken ?? row.isBroken),
        variantStatus: row.variant_status ?? row.variantStatus,
        feishuNotifyEnabled: Number(row.feishuNotifyEnabled),
        createTime: row.createTime,
        updateTime: row.updateTime,
        lastCheckTime: row.lastCheckTime ? 'CHECKED' : null,
      })),
    },
  };
};

describe('competitor immediate check / actual Legacy service parity', () => {
  it('matches the successful single-ASIN result and each history record', async () => {
    const left = fixture(),
      right = fixture();
    const old = legacy(left),
      current = neo(right);
    try {
      const expected = plain(await old.checkSingle('a1'));
      const actual = plain(
        await current.service.checkSingle('a1', current.context),
      );
      expect(actual).toEqual(expected);
      expect(historyRows(current.history)).toEqual(historyRows(old.history));
      expect(current.children[0].isBroken).toBe(
        Boolean(old.children[0].isBroken),
      );
    } finally {
      current.service.close();
    }
  });

  it('matches the complete successful group result and ordered history records', async () => {
    const left = fixture(),
      right = fixture();
    left.results.set('B000000002', catalogNotFoundResult('B000000002', 'US'));
    right.results.set('B000000002', catalogNotFoundResult('B000000002', 'US'));
    const old = legacy(left),
      current = neo(right);
    try {
      const expected = await old.checkGroup('g1');
      const actual = await current.service.checkGroup('g1', current.context);
      expect(groupResult(actual)).toEqual(groupResult(expected));
      expect(historyRows(current.history)).toEqual(historyRows(old.history));
      expect(current.group.isBroken).toBe(Boolean(old.group.isBroken));
    } finally {
      current.service.close();
    }
  });

  it('matches recoverable group failure without exposing a different history shape', async () => {
    const left = fixture(),
      right = fixture();
    left.results.set('B000000001', new Error('SP-API检查失败'));
    right.results.set('B000000001', new Error('SP-API检查失败'));
    const old = legacy(left),
      current = neo(right);
    try {
      const expected = await old.checkGroup('g1');
      const actual = await current.service.checkGroup('g1', current.context);
      expect(groupResult(actual)).toEqual(groupResult(expected));
      expect(historyRows(current.history)).toEqual(historyRows(old.history));
      expect(current.children[0].isBroken).toBe(
        Boolean(old.children[0].isBroken),
      );
    } finally {
      current.service.close();
    }
  });
});
