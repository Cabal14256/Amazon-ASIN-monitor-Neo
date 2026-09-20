/** Only row-local data/constraint exceptions may be retried after a savepoint. */
export function recoverableCompetitorBatchError(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === 'object';
    depth++
  ) {
    const value = current as { code?: unknown; cause?: unknown };
    if (
      typeof value.code === 'string' &&
      /^(?:22|23)[A-Z0-9]{3}$|^P0001$/.test(value.code)
    )
      return true;
    current = value.cause;
  }
  return false;
}

export function duplicateCompetitorAsin(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === 'object';
    depth++
  ) {
    const value = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      value.code === '23505' &&
      typeof value.constraint === 'string' &&
      [
        'uk_competitor_asins_asin_country',
        'uq_competitor_asins_asin_country_ci',
        'idx_neo_competitor_write_asin_country',
      ].includes(value.constraint)
    )
      return true;
    current = value.cause;
  }
  return false;
}
