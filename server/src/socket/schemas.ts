import { z } from 'zod';
import { DISPLAY_NAME_MAX_LENGTH, TRANSCRIPT_TEXT_MAX_LENGTH } from '../../../shared/protocol.js';

// Control characters (C0/C1) and bidi overrides are stripped from user text.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export const roomIdSchema = z.string().regex(/^[a-f0-9]{16}$/, 'Invalid room ID');

export const displayNameSchema = z
  .string()
  .transform((s) => s.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Display name is required').max(DISPLAY_NAME_MAX_LENGTH));

export const mediaStateSchema = z.object({
  audioEnabled: z.boolean(),
  videoEnabled: z.boolean(),
});

export const joinSchema = z.object({
  roomId: roomIdSchema,
  displayName: displayNameSchema,
  hostKey: z.string().min(1).max(64).optional(),
  media: mediaStateSchema,
});

const sdpSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(20_000),
});

const candidateSchema = z
  .object({
    candidate: z.string().max(1_000),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .nullable();

export const signalSchema = z.object({
  to: z.uuid(),
  data: z.discriminatedUnion('type', [
    z.object({ type: z.literal('description'), description: sdpSchema }),
    z.object({ type: z.literal('candidate'), candidate: candidateSchema }),
  ]),
});

export const transcriptEntrySchema = z.object({
  sessionId: z.uuid(),
  text: z
    .string()
    .max(TRANSCRIPT_TEXT_MAX_LENGTH * 2)
    .transform((s) => s.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1).max(TRANSCRIPT_TEXT_MAX_LENGTH)),
});

export const downloadSchema = z.object({
  timeZone: z.string().max(64).optional(),
  locale: z.string().max(35).optional(),
});
