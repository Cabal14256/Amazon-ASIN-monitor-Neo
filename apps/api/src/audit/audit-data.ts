const MASK = '***REDACTED***';
const OMITTED = '[omitted]';
const SENSITIVE =
  /password|pwd|token|secret|apikey|accesskey|authorization|auth|cookie|webhook|credential|configvalue|displayvalue/;
const PERSONAL =
  /realname|fullname|displayname|statusreason|email|phone|mobile|address|birthday|dateofbirth|passport|identitynumber/;

export function auditText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return (
    String(value)
      .replace(/\0/g, '')
      .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ' + MASK)
      .replace(/([a-z][a-z\d+.-]*:\/\/)[^@\s/]+@/gi, '$1' + MASK + '@')
      .replace(
        /\b(password|token|secret|authorization)=([^&\s]+)/gi,
        '$1=' + MASK,
      )
      .slice(0, limit) || null
  );
}

export function auditBody(value: unknown): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.isBuffer(value)
  )
    return null;
  let remaining = 128;
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 6) return OMITTED;
    if (typeof input === 'string') return auditText(input, 1024);
    if (
      input === null ||
      typeof input === 'number' ||
      typeof input === 'boolean'
    )
      return input;
    if (!input || typeof input !== 'object' || Buffer.isBuffer(input))
      return OMITTED;
    if (seen.has(input)) return OMITTED;
    seen.add(input);
    if (Array.isArray(input))
      return input.slice(0, 32).map((item) => visit(item, depth + 1));
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(input)) {
      if (remaining <= 0) break;
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      // configValue/config_value 不按名称猜测安全性：所有配置值都掩码，包括新增凭据类型。
      const sensitive = SENSITIVE.test(normalized) || PERSONAL.test(normalized);
      result[key.replace(/\0/g, '').slice(0, 100)] = sensitive
        ? MASK
        : visit(child, depth + 1);
      if (sensitive) remaining -= 1;
    }
    return result;
  }
  const result = visit(value, 0) as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16_384
    ? result
    : { omitted: 'request_data_size_limit' };
}
