import { isNeoBatchDeleteId } from '@asin-monitor/contracts';
import { AsinQueryInputError } from './asin-query-values';

/** Decode the original wire query strictly; Fastify's tolerant query parser can
 * replace malformed UTF-8 and collapse distinctions between literal keys. */
export function parseCatalogLiteralDetailQuery(url: string): string {
  const start = url.indexOf('?');
  if (start < 0) throw new AsinQueryInputError();
  const fields = url.slice(start + 1).split('&');
  if (fields.length !== 1) throw new AsinQueryInputError();
  const separator = fields[0].indexOf('=');
  if (separator < 0) throw new AsinQueryInputError();
  try {
    const decode = (value: string) =>
      decodeURIComponent(value.replace(/\+/g, ' '));
    const name = decode(fields[0].slice(0, separator));
    const id = decode(fields[0].slice(separator + 1));
    if (name !== 'groupId' || !isNeoBatchDeleteId(id))
      throw new AsinQueryInputError();
    return id;
  } catch {
    throw new AsinQueryInputError();
  }
}
