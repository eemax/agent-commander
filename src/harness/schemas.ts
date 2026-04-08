import { z } from "zod";

const envSchema = z.record(z.string(), z.string());

export const bashInputSchema = z
  .object({
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    env: envSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    yieldMs: z.number().int().positive().optional(),
    background: z.boolean().optional(),
    shell: z.string().min(1).optional()
  })
  .strict();

const listProcessSchema = z
  .object({
    action: z.literal("list")
  });

const pollProcessSchema = z
  .object({
    action: z.literal("poll"),
    sessionId: z.string().min(1)
  });

const logProcessSchema = z
  .object({
    action: z.literal("log"),
    sessionId: z.string().min(1),
    tailLines: z.number().int().positive().optional()
  });

const writeProcessSchema = z
  .object({
    action: z.literal("write"),
    sessionId: z.string().min(1),
    input: z.string()
  });

const killProcessSchema = z
  .object({
    action: z.literal("kill"),
    sessionId: z.string().min(1),
    signal: z.string().min(1).optional()
  });

const clearProcessSchema = z
  .object({
    action: z.literal("clear"),
    sessionId: z.string().min(1)
  });

const removeProcessSchema = z
  .object({
    action: z.literal("remove"),
    sessionId: z.string().min(1)
  });

export const processInputSchema = z.discriminatedUnion("action", [
  listProcessSchema,
  pollProcessSchema,
  logProcessSchema,
  writeProcessSchema,
  killProcessSchema,
  clearProcessSchema,
  removeProcessSchema
]);

export const readFileInputSchema = z
  .object({
    path: z.string().min(1),
    offsetLine: z.number().int().positive().optional(),
    limitLines: z.number().int().positive().optional(),
    encoding: z.string().min(1).optional()
  })
  .strict();

export const writeFileInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.string().min(1).optional()
  })
  .strict();

export const replaceInFileInputSchema = z
  .object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().optional()
  })
  .strict();

export const globInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional()
  })
  .strict();

export const grepInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    literal: z.boolean().optional(),
    caseSensitive: z.boolean().optional()
  })
  .strict();

export const applyPatchInputSchema = z
  .object({
    patch: z.string().min(1),
    cwd: z.string().min(1).optional()
  })
  .strict();

const httpUrlSchema = z.string().min(1).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "Invalid URL: expected an http(s) URL");

export const webSearchInputSchema = z
  .object({
    query: z.string().min(1)
  })
  .strict();

export const webFetchInputSchema = z
  .object({
    url: httpUrlSchema
  })
  .strict();

export type BashInput = z.infer<typeof bashInputSchema>;
export type ProcessInput = z.infer<typeof processInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type ReplaceInFileInput = z.infer<typeof replaceInFileInputSchema>;
export type GlobInput = z.infer<typeof globInputSchema>;
export type GrepInput = z.infer<typeof grepInputSchema>;
export type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
