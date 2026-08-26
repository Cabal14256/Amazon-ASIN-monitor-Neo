import { z } from 'zod';

import { resultSchema } from '../envelope';

export const systemAlertSchema = z.object({
  message: z.string(),
  type: z.string(),
});
export type SystemAlert = z.infer<typeof systemAlertSchema>;

export const systemAlertResultSchema = resultSchema(systemAlertSchema);
