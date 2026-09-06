import http, { type ClientRequest } from 'node:http';
import https from 'node:https';
import { abortError, SpApiError } from './errors';
import type { HttpInput, HttpResponse, Transport } from './types';

/** Bounded actual I/O; no redirects, hidden retries, credential/payload error dumps. */
export class NodeHttpTransport implements Transport {
  private readonly requests = new Map<
    ClientRequest,
    (error: SpApiError) => void
  >();
  private closed = false;
  private readonly httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
  });
  private readonly httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
  });
  constructor(
    private readonly options: {
      timeoutMs?: number;
      maxResponseBytes?: number;
      maxInFlight?: number;
      allowLocalHttp?: boolean;
    } = {},
  ) {
    for (const [value, max] of [
      [options.timeoutMs ?? 30000, 60000],
      [options.maxResponseBytes ?? 8 * 1024 * 1024, 32 * 1024 * 1024],
      [options.maxInFlight ?? 64, 128],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new SpApiError('INVALID_CONFIG');
    }
  }
  request(input: HttpInput): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const fail = (code: ConstructorParameters<typeof SpApiError>[0]) =>
        reject(new SpApiError(code));
      if (this.closed) return fail('CLOSED');
      if (input.signal.aborted) return reject(abortError(input.signal));
      const local =
        this.options.allowLocalHttp &&
        input.url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(input.url.hostname);
      if (input.url.protocol !== 'https:' && !local)
        return fail('INVALID_INPUT');
      if (input.url.username || input.url.password)
        return fail('INVALID_INPUT');
      if (input.body && Buffer.byteLength(input.body) > 1024 * 1024)
        return fail('BODY_TOO_LARGE');
      if (this.requests.size >= (this.options.maxInFlight ?? 64))
        return fail('CAPACITY');
      let settled = false;
      let req: ClientRequest | undefined;
      const finish = (error?: SpApiError, response?: HttpResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(response!);
      };
      const stop = (error: SpApiError) => {
        // Settle with the precise cause before Node emits response.aborted/error.
        finish(error);
        req?.destroy(error);
      };
      const abort = () => stop(abortError(input.signal));
      const timer = setTimeout(
        () => stop(new SpApiError('TIMEOUT')),
        this.options.timeoutMs ?? 30000,
      );
      try {
        req = (local ? http : https).request(
          input.url,
          {
            method: input.method,
            headers: input.headers,
            agent: local ? this.httpAgent : this.httpsAgent,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > (this.options.maxResponseBytes ?? 8 * 1024 * 1024)) {
                stop(new SpApiError('BODY_TOO_LARGE'));
                response.destroy();
              } else chunks.push(chunk);
            });
            response.on('error', () => stop(new SpApiError('HTTP_ERROR')));
            response.on('end', () => {
              if (!response.complete) return stop(new SpApiError('HTTP_ERROR'));
              finish(undefined, {
                statusCode: response.statusCode ?? 502,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
            response.on('aborted', () => stop(new SpApiError('HTTP_ERROR')));
          },
        );
        this.requests.set(req, stop);
        const activeRequest = req;
        req.on('close', () => this.requests.delete(activeRequest));
        req.on('error', (error) =>
          finish(
            error instanceof SpApiError ? error : new SpApiError('HTTP_ERROR'),
          ),
        );
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) abort();
        else req.end(input.body);
      } catch {
        stop(new SpApiError('HTTP_ERROR'));
      }
    });
  }
  close(): void {
    this.closed = true;
    for (const stop of this.requests.values()) stop(new SpApiError('CLOSED'));
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}
