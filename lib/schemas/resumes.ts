import { z } from 'zod';

export const resumeCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  targetType: z.string().trim().min(1, 'Target type is required'),
  fileName: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
});

export type ResumeCreateInput = z.infer<typeof resumeCreateSchema>;
