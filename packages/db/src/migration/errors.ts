export class DataMigrationError extends Error {
  constructor(
    public readonly code: string,
    public readonly scope: string,
    safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
    this.name = 'DataMigrationError';
  }
}

export function asDataMigrationError(
  error: unknown,
  fallbackScope = 'migration',
): DataMigrationError {
  if (error instanceof DataMigrationError) return error;
  return new DataMigrationError(
    'UNEXPECTED_MIGRATION_ERROR',
    fallbackScope,
    'unexpected migration failure',
    error instanceof Error ? { cause: error } : undefined,
  );
}
