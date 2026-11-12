// A5 connector front door: explicit history reads, independent of host wake.
import type { VortexClient, WireApiMessage } from './client.ts'
import { measure } from './render.ts'

export interface ReadArgs { scope: 'room' | 'dm'; room?: string; after: number; limit: number }

export const READ_TOOL = {
  name: 'vx_read',
  description: 'Read VORTEX room history or your own DMs without marking messages delivered. Use the returned after cursor to continue.',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['room', 'dm'], description: 'Room history by default; dm reads only your own DMs.' },
      room: { type: 'string', pattern: '^[a-z0-9-]{1,32}$', description: 'Room name; defaults to all. Omit for DMs.' },
      after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Sequence cursor from the previous read; defaults to 0.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum messages; defaults to 20. Render bounds may shorten the page.' },
    },
    additionalProperties: false,
  },
} as const

const ALLOWED = new Set(['scope', 'room', 'after', 'limit'])

export function parseReadArgs (raw: unknown = {}): ReadArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('arguments must be an object')
  const a = raw as Record<string, unknown>
  for (const key of Object.keys(a)) if (!ALLOWED.has(key)) throw new Error(`unknown argument: ${key}`)
  const scope = a.scope === undefined ? 'room' : a.scope
  if (scope !== 'room' && scope !== 'dm') throw new Error('scope must be "room" or "dm"')
  if (scope === 'dm' && a.room !== undefined) throw new Error('room must be omitted for DMs')
  const room = a.room === undefined ? 'all' : a.room
  if (typeof room !== 'string' || !/^[a-z0-9-]{1,32}$/.test(room)) throw new Error('invalid room')
  const after = a.after === undefined ? 0 : a.after
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw new Error('after must be a safe integer >= 0')
  const limit = a.limit === undefined ? 20 : a.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer in 1..20')
  return { scope, ...(scope === 'room' ? { room } : {}), after, limit }
}

/** No stream, batch, receipt or state write: just authenticated log queries. */
export async function readHistory (client: VortexClient, args: ReadArgs): Promise<string> {
  const page = (after: number, limit: number) => args.scope === 'dm'
    ? client.ownDmLog(after, limit)
    : client.roomLog(args.room!, after, limit)
  const { messages } = await page(args.after, args.limit + 1)
  const picked: WireApiMessage[] = []
  const compose = () => ({ batch: 'history', scope: args.scope, room: args.room, messages: picked })
  for (const message of messages.slice(0, args.limit)) {
    const candidate = { ...compose(), messages: [...picked, message] }
    if (!measure(candidate).fits) break
    picked.push(message)
  }
  if (messages.length > 0 && picked.length === 0) throw new Error('next message exceeds vx_read render bounds; cursor unchanged')
  const next = picked[picked.length - 1]?.seq ?? args.after
  // A shorter server-side log cap may hide the extra row; one bounded follow-up
  // query distinguishes that from the end of history. This is not polling.
  const more = messages.length > picked.length ||
    (picked.length > 0 && (await page(next, 1)).messages.length > 0)
  // The ASCII footer+separator is at most 96 bytes with a safe-integer cursor.
  return `${measure(compose()).text}\n[vx: next after=${next}; more=${more}]`
}
