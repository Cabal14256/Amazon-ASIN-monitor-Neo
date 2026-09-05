import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signRequest } from '../src/signature';
import { fixture } from './fixtures';

describe('optional SigV4 canonicalization', () => {
  it.each([
    ['/catalog/2022-04-01/items', '/catalog/2022-04-01/items'],
    ['/x%20y/%2F', '/x%2520y/%252F'],
  ])(
    'matches a literal canonical request for %s with sorted query and signed date',
    (path, canonicalPath) => {
      const f = fixture();
      f.client.close();
      const credentials = {
        ...f.config.regions.US,
        accessKeyId: 'fixture-key',
        secretAccessKey: 'fixture-signing-key',
        sessionToken: 'fixture-session',
      };
      const signed = signRequest(
        'GET',
        new URL(
          `https://sellingpartnerapi-na.amazon.com${path}?z=2&includedData=summaries%2Crelationships&z=1&marketplaceIds=ATVPDKIKX0DER`,
        ),
        {
          'X-Amz-Access-Token': 'fixture-access',
          Authorization: 'ignored',
          Accept: ' application/json ',
          'User-Agent': 'fixture-agent',
          Connection: 'keep-alive',
        },
        '',
        credentials,
        'us-east-1',
        new Date('2026-09-05T00:00:00Z'),
      );
      // Literal fixture checks construction independently, especially the old
      // Legacy mistake of putting ?query inside canonical URI and leaving query empty.
      const canonical = [
        'GET',
        canonicalPath,
        'includedData=summaries%2Crelationships&marketplaceIds=ATVPDKIKX0DER&z=1&z=2',
        'accept:application/json\nhost:sellingpartnerapi-na.amazon.com\nx-amz-access-token:fixture-access\nx-amz-date:20260905T000000Z\nx-amz-security-token:fixture-session\n',
        'accept;host;x-amz-access-token;x-amz-date;x-amz-security-token',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n');
      let key: string | Buffer = 'AWS4fixture-signing-key';
      for (const part of [
        '20260905',
        'us-east-1',
        'execute-api',
        'aws4_request',
      ])
        key = createHmac('sha256', key).update(part).digest();
      const hash = createHash('sha256').update(canonical).digest('hex');
      const expected = createHmac('sha256', key)
        .update(
          `AWS4-HMAC-SHA256\n20260905T000000Z\n20260905/us-east-1/execute-api/aws4_request\n${hash}`,
        )
        .digest('hex');
      expect(signed.authorization).toBe(
        `AWS4-HMAC-SHA256 Credential=fixture-key/20260905/us-east-1/execute-api/aws4_request, SignedHeaders=accept;host;x-amz-access-token;x-amz-date;x-amz-security-token, Signature=${expected}`,
      );
      expect(signed['x-amz-security-token']).toBe('fixture-session');
    },
  );
  it('normalizes equivalent encoded query order but binds the method, body and region', () => {
    const f = fixture();
    f.client.close();
    const credentials = {
      ...f.config.regions.US,
      accessKeyId: 'fixture-key',
      secretAccessKey: 'fixture-signing-key',
    };
    const sign = (
      query: string,
      method = 'POST',
      body = '{}',
      region = 'eu-west-1',
    ) =>
      signRequest(
        method,
        new URL(
          `https://sellingpartnerapi-eu.amazon.com/catalog/2022-04-01/items?${query}`,
        ),
        {},
        body,
        credentials,
        region,
        new Date('2026-09-05T00:00:00Z'),
      ).authorization;
    expect(sign('z=%21%2A&x=a+b')).toBe(sign('x=a%20b&z=!*'));
    expect(sign('x=1')).not.toBe(sign('x=1', 'GET'));
    expect(sign('x=1')).not.toBe(sign('x=1', 'POST', '{"x":1}'));
    expect(sign('x=1')).not.toBe(sign('x=1', 'POST', '{}', 'us-east-1'));
  });
  it('fails closed on missing signing keys', () => {
    const f = fixture();
    f.client.close();
    expect(() =>
      signRequest(
        'GET',
        new URL('https://sellingpartnerapi-na.amazon.com/'),
        {},
        '',
        f.config.regions.US,
        'us-east-1',
      ),
    ).toThrow('INVALID_CONFIG');
  });
});
