import { createHash, createHmac } from 'node:crypto';
import { SpApiError } from './errors';
import { encode } from './request';
import type { Credentials } from './types';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest();
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}
export function signRequest(
  method: string,
  url: URL,
  inputHeaders: Record<string, string>,
  payload: string,
  credentials: Credentials,
  region: string,
  now = new Date(),
): Record<string, string> {
  if (!credentials.accessKeyId || !credentials.secretAccessKey)
    throw new SpApiError('INVALID_CONFIG');
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputHeaders)) {
    if (key.toLowerCase() !== 'authorization')
      headers[key.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  headers.host = url.host;
  headers['x-amz-date'] = amzDate(now);
  if (credentials.sessionToken)
    headers['x-amz-security-token'] = credentials.sessionToken;
  // Follow AWS' generic SigV4 rules, not the S3-specific raw-path variant.
  const unsignedHeaders = new Set([
    'connection',
    'expect',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'user-agent',
    'x-amzn-trace-id',
  ]);
  const headerNames = Object.keys(headers)
    .filter((key) => !unsignedHeaders.has(key))
    .sort();
  const canonicalHeaders = headerNames
    .map((key) => `${key}:${headers[key]}\n`)
    .join('');
  const signedHeaders = headerNames.join(';');
  const canonicalQuery = [...url.searchParams]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
        ? 1
        : a[1] < b[1]
        ? -1
        : a[1] > b[1]
        ? 1
        : 0,
    )
    .map((pair) => pair.join('='))
    .join('&');
  const canonicalPath = url.pathname
    .replace(/\/+/g, '/')
    .split('/')
    .map(encode)
    .join('/');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    hash(payload),
  ].join('\n');
  const date = headers['x-amz-date'].slice(0, 8);
  const scope = `${date}/${region}/execute-api/aws4_request`;
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region),
      'execute-api',
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(
      `AWS4-HMAC-SHA256\n${headers['x-amz-date']}\n${scope}\n${hash(
        canonicalRequest,
      )}`,
    )
    .digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
