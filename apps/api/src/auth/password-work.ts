import { HttpException } from '@nestjs/common';

const MAX_PASSWORD_WORK = 8;
let active = 0;

/** HTTP/SQL deadlines cannot cancel bcrypt: release only when actual CPU work settles. */
export async function boundedPasswordWork<T>(
  operation: () => Promise<T>,
  message: string,
): Promise<T> {
  if (active >= MAX_PASSWORD_WORK)
    throw new HttpException(
      { success: false, errorCode: 429, errorMessage: message },
      429,
    );
  active++;
  try {
    return await operation();
  } finally {
    active--;
  }
}
