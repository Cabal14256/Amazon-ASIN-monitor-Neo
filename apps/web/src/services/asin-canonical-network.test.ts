import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../lib/http';
import { sessionFixture } from '../lib/transport-fixtures';
import {
  createAsin,
  deleteAsin,
  getVariantGroup,
  moveAsin,
  updateVariantGroup,
} from './asin';

const groupId = ' Gróup 主营 ';
const childId = ' Child α ';
const targetId = ' Cible 目标 ';
const group = {
  id: groupId,
  name: 'Fixture',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  children: [],
};
let server: Server | undefined;
let client: HttpClient | undefined;
afterEach(async () => {
  client?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  server = undefined;
  client = undefined;
});

describe('canonical record IDs over actual loopback HTTP', () => {
  it.each(['same-origin', 'gateway'] as const)(
    'preserves native wire paths and JSON IDs with the %s deployment',
    async (deployment) => {
      const received: Array<{ url: string; method: string; body: unknown }> =
        [];
      server = createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const raw = Buffer.concat(parts).toString('utf8');
        received.push({
          url: req.url!,
          method: req.method!,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            success: true,
            data:
              req.method === 'DELETE'
                ? '删除成功'
                : req.url!.includes('/asins')
                ? { id: childId, asin: 'B000000001', country: 'US' }
                : group,
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', resolve),
      );
      const origin = `http://127.0.0.1:${
        (server.address() as AddressInfo).port
      }`;
      const prefix = deployment === 'gateway' ? '/gateway/api/v1' : '/api/v1';
      client = new HttpClient({
        baseURL: deployment === 'gateway' ? `${origin}/gateway/api/` : '/api/',
        pageOrigin: origin,
        session: sessionFixture().store,
      });
      await getVariantGroup(client, groupId);
      await updateVariantGroup(client, groupId, {
        name: group.name,
        country: group.country,
        site: group.site,
        brand: group.brand,
      });
      await createAsin(client, {
        asin: 'B000000001',
        country: 'US',
        site: 'amazon.com',
        brand: 'Fixture',
        parentId: groupId,
      });
      await moveAsin(client, childId, { targetGroupId: targetId });
      await deleteAsin(client, childId);
      expect(received.map(({ method, url }) => [method, url])).toEqual([
        ['GET', `${prefix}/variant-groups/${encodeURIComponent(groupId)}`],
        ['PUT', `${prefix}/variant-groups/${encodeURIComponent(groupId)}`],
        ['POST', `${prefix}/asins`],
        ['POST', `${prefix}/asins/${encodeURIComponent(childId)}/move`],
        ['DELETE', `${prefix}/asins/${encodeURIComponent(childId)}`],
      ]);
      expect(received[2].body).toMatchObject({ parentId: groupId });
      expect(received[3].body).toEqual({ targetGroupId: targetId });
      expect(received.every(({ url }) => !url.includes('/api/api/'))).toBe(
        true,
      );
    },
  );
});
