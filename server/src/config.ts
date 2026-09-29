import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: optionalString,
  /** Number of reverse proxies in front of the app (Nginx Proxy Manager = 1). */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  AZURE_SPEECH_KEY: optionalString,
  AZURE_SPEECH_REGION: optionalString,
  AZURE_SPEECH_LANGUAGE: z.string().trim().min(2).max(20).default('tr-TR'),

  STUN_URL: csvList,
  TURN_URL: csvList,
  TURN_USERNAME: optionalString,
  TURN_PASSWORD: optionalString,
  /** If set, time-limited TURN credentials are minted (coturn use-auth-secret) instead of static ones. */
  TURN_SHARED_SECRET: optionalString,
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(6 * 3600),

  // In-memory abuse limits (container memory limit is 512 MB).
  MAX_ROOMS: z.coerce.number().int().min(1).max(10_000).default(100),
  MAX_TRANSCRIPT_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(2_000),
  MAX_TRANSCRIPT_CHARS_PER_SESSION: z.coerce.number().int().min(1_000).max(10_000_000).default(500_000),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Only report which variables are invalid, never their values.
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    host: e.HOST,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    speech: {
      key: e.AZURE_SPEECH_KEY,
      region: e.AZURE_SPEECH_REGION,
      language: e.AZURE_SPEECH_LANGUAGE,
    },
    limits: {
      maxRooms: e.MAX_ROOMS,
      maxTranscriptEntries: e.MAX_TRANSCRIPT_ENTRIES,
      maxTranscriptCharsPerSession: e.MAX_TRANSCRIPT_CHARS_PER_SESSION,
    },
    ice: {
      stunUrls: e.STUN_URL,
      turnUrls: e.TURN_URL,
      turnUsername: e.TURN_USERNAME,
      turnPassword: e.TURN_PASSWORD,
      turnSharedSecret: e.TURN_SHARED_SECRET,
      turnCredentialTtlSeconds: e.TURN_CREDENTIAL_TTL_SECONDS,
    },
  };
}
