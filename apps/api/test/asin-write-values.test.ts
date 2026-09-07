import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  AsinWriteInputError,
  parseAsinCreate,
  parseAsinManual,
  parseAsinMove,
  parseAsinNotify,
  parseAsinUpdate,
  parseAsinWriteId,
  parseGroupManual,
  parseVariantGroupWrite,
} from '../src/asin/asin-write-values';

const group = {
  name: ' Fixture group ',
  country: 'us',
  site: ' amazon.com ',
  brand: 'Fixture brand',
};
const asin = {
  asin: 'b000000085',
  name: 'Fixture product',
  country: 'us',
  site: 'amazon.com',
  brand: 'Fixture',
  asinType: '1' as const,
};
function legacy() {
  const calls = {
    createGroup: vi.fn(async (..._args: unknown[]) => ({})),
    updateGroup: vi.fn(async (..._args: unknown[]) => ({})),
    createAsin: vi.fn(async (..._args: unknown[]) => ({})),
    updateAsin: vi.fn(async (..._args: unknown[]) => ({})),
    move: vi.fn(async (..._args: unknown[]) => ({})),
    groupManual: vi.fn(async (..._args: unknown[]) => ({})),
    asinManual: vi.fn(async (..._args: unknown[]) => ({})),
  };
  const module = {
    exports: {} as Record<string, (req: any, res: any) => Promise<void>>,
  };
  vm.runInNewContext(
    readFileSync(
      resolve(__dirname, '../../../server/src/controllers/asinController.js'),
      'utf8',
    ),
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === '../models/VariantGroup')
          return {
            create: calls.createGroup,
            update: calls.updateGroup,
            updateManualBroken: calls.groupManual,
          };
        if (name === '../models/ASIN')
          return {
            create: calls.createAsin,
            update: calls.updateAsin,
            moveToGroup: calls.move,
            updateManualBrokenAction: calls.asinManual,
          };
        if (name === '../services/sharedService')
          return {
            validateRequiredFields: (
              body: Record<string, unknown>,
              keys: string[],
            ) => {
              if (keys.some((key) => !body[key]))
                throw new Error('Fixture invalid legacy input');
            },
            sendSuccessResponse: () => undefined,
            sendErrorResponse: () => undefined,
            handleControllerError: () => {
              throw new Error('Unexpected fixture controller error');
            },
          };
        return {};
      },
    },
  );
  return { ...calls, controller: module.exports };
}
describe('ASIN write values / actual Legacy controller inputs', () => {
  it.each([true, false, 0, 1, '0', '1'])(
    'matches actual Legacy group manual input %s',
    async (markedBroken) => {
      const f = legacy();
      const body = { markedBroken, reason: ' reason\nwith detail ' };
      await f.controller.updateVariantGroupManualBroken(
        { params: { groupId: 'g' }, body },
        {},
      );
      const [recordId, marked, reason] = f.groupManual.mock.calls[0];
      expect(recordId).toBe('g');
      expect(parseGroupManual(body)).toEqual({ markedBroken: marked, reason });
    },
  );
  it.each([
    { action: ' mark_broken ', reason: ' reason ' },
    { action: 'clear_self_manual' },
    {
      action: ' exclude_group_manual ',
      markedBroken: false,
      reason: ' reason ',
    },
    { action: 'clear_group_exclusion' },
    { action: 'invalid', markedBroken: '1', reason: ' fallback ' },
    { markedBroken: '0' },
    { action: 7, markedBroken: 1, reason: ' fallback ' },
    { action: 'CLEAR_SELF_MANUAL', markedBroken: 'invalid' },
  ])('matches actual Legacy ASIN manual action %j', async (body) => {
    const f = legacy();
    await f.controller.updateASINManualBroken(
      { params: { asinId: 'a' }, body },
      {},
    );
    const [recordId, fields] = f.asinManual.mock.calls[0] as [
      string,
      { action: string; reason: string },
    ];
    expect(recordId).toBe('a');
    expect(parseAsinManual(body)).toEqual({
      action: fields.action,
      reason: fields.reason,
    });
  });
  it.each([
    null,
    [],
    {},
    { markedBroken: 2 },
    { markedBroken: true, reason: ' ' },
    { markedBroken: false, reason: 'x'.repeat(501) },
    { markedBroken: false, updatedBy: 'spoof' },
  ])('rejects invalid group manual body %j', (value) => {
    expect(() => parseGroupManual(value)).toThrow(AsinWriteInputError);
  });
  it.each([
    null,
    [],
    {},
    { action: 'invalid' },
    { action: 'MARK_BROKEN' },
    { action: 'EXCLUDE_GROUP_MANUAL', reason: ' ' },
    { action: 'CLEAR_SELF_MANUAL', reason: 'x'.repeat(501) },
    { markedBroken: false, operator: 'spoof' },
  ])('rejects invalid ASIN manual body %j', (value) => {
    expect(() => parseAsinManual(value)).toThrow(AsinWriteInputError);
  });
  it.each([true, false, 0, 1])(
    'normalizes the accepted notification flag %s',
    (enabled) => {
      expect(parseAsinNotify({ enabled })).toBe(
        enabled === true || enabled === 1,
      );
    },
  );
  it.each([
    null,
    undefined,
    '1',
    '0',
    2,
    -1,
    {},
    [],
    { enabled: true, manualBroken: true },
  ])('rejects invalid notification input %j', (value) => {
    const input =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'enabled' in value
        ? value
        : { enabled: value };
    expect(() => parseAsinNotify(input)).toThrow(AsinWriteInputError);
  });
  it('uses database character limits for supplementary Unicode instead of halving them', () => {
    const name = '🛒'.repeat(255);
    const brand = '🛒'.repeat(100);
    expect(parseVariantGroupWrite({ ...group, name, brand })).toMatchObject({
      name,
      brand,
    });
    expect(
      parseAsinUpdate({ ...asin, name: '🛒'.repeat(500) }).name,
    ).toHaveLength(1000);
    expect(parseAsinWriteId('🛒'.repeat(50))).toHaveLength(100);
    expect(() =>
      parseVariantGroupWrite({ ...group, name: `${name}🛒` }),
    ).toThrow(AsinWriteInputError);
    expect(() => parseAsinWriteId('🛒'.repeat(51))).toThrow(
      AsinWriteInputError,
    );
  });
  it('preserves group text without silently changing case or trimming accepted values', async () => {
    const f = legacy();
    await f.controller.createVariantGroup({ body: group }, {});
    expect(parseVariantGroupWrite(group)).toEqual(
      f.createGroup.mock.calls[0][0],
    );
    await f.controller.updateVariantGroup(
      { params: { groupId: 'g1' }, body: group },
      {},
    );
    expect(parseVariantGroupWrite(group)).toEqual(
      f.updateGroup.mock.calls[0][1],
    );
  });
  it('preserves create, update and move field values and parent identity', async () => {
    const f = legacy();
    const body = { ...asin, parentId: 'g1' };
    await f.controller.createASIN({ body }, {});
    const { parentId, ...created } = parseAsinCreate(body);
    expect({ ...created, variantGroupId: parentId }).toEqual(
      f.createAsin.mock.calls[0][0],
    );
    await f.controller.updateASIN({ body: asin, params: { asinId: 'a1' } }, {});
    expect(parseAsinUpdate(asin)).toEqual(f.updateAsin.mock.calls[0][1]);
    await f.controller.moveASIN(
      { body: { targetGroupId: 'g2' }, params: { asinId: 'a1' } },
      { json() {} },
    );
    expect(parseAsinMove({ targetGroupId: 'g2' }).targetGroupId).toBe(
      f.move.mock.calls[0][1],
    );
  });
  it.each([1, 2, '1', '2', null, undefined])(
    'normalizes optional ASIN type %s to its database representation',
    (value) => {
      expect(
        parseAsinCreate({ ...asin, parentId: 'g1', asinType: value }).asinType,
      ).toBe(value == null ? null : String(value));
    },
  );
  it.each(['', null, undefined])(
    'normalizes optional name %s to null consistently on create/update',
    (name) => {
      expect(
        parseAsinCreate({ ...asin, parentId: 'g1', name }).name,
      ).toBeNull();
      expect(parseAsinUpdate({ ...asin, name }).name).toBeNull();
    },
  );
  it.each([
    null,
    [],
    {},
    { ...group, name: ' ' },
    { ...group, name: 'x'.repeat(256) },
    { ...group, country: 'x'.repeat(11) },
    { ...group, site: 'x'.repeat(101) },
    { ...group, brand: 'x'.repeat(101) },
    { ...group, name: '\n' },
    { ...group, manualBroken: true },
  ])('rejects invalid group shape %j', (value) => {
    expect(() => parseVariantGroupWrite(value)).toThrow(AsinWriteInputError);
  });
  it.each([
    { ...asin, parentId: 'g1', asin: 'x'.repeat(21) },
    { ...asin, parentId: 'g1', name: 'x'.repeat(501) },
    { ...asin, parentId: 'g1', asinType: 'MAIN_LINK' },
    { ...asin, parentId: 'g1', asinType: false },
    { ...asin, parentId: 'g1', manualExcludedFromGroup: true },
    { ...asin, parentId: ' ' },
  ])('rejects invalid create shape %j', (value) => {
    expect(() => parseAsinCreate(value)).toThrow(AsinWriteInputError);
  });
  it.each(['', ' ', 'x'.repeat(51), '\0', 123])(
    'rejects invalid IDs %j',
    (value) => {
      expect(() => parseAsinWriteId(value)).toThrow(AsinWriteInputError);
      expect(() => parseAsinMove({ targetGroupId: value })).toThrow(
        AsinWriteInputError,
      );
    },
  );
});
