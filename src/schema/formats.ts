import { z } from 'zod';

/**
 * zod 3 to 4. Two string formats whose zod 4 builders accept less than the zod 3
 * builders this codebase was written against. Both stay at their zod 3 acceptance here, on
 * purpose, because this change is a dependency upgrade and must not change
 * which writes the engine takes.
 *
 * Identifiers. zod 3's `z.string().uuid()` accepted any 8-4-4-4-12 hex string. zod 4's
 * `z.uuid()` also checks the RFC 9562 version and variant digits, so an id such as
 * 11111111-1111-1111-1111-111111111111, which a caller could send before this change, would be
 * refused after it. `z.guid()` is zod 4's name for the permissive form, and its pattern is the
 * zod 3 pattern.
 *
 * Timestamps. zod 3's `z.string().datetime({ offset: true })` accepted a time with no seconds
 * (12:00Z) and an offset with no colon (+0200). zod 4's `z.iso.datetime({ offset: true })`
 * follows RFC 3339 and refuses both. The pattern below is zod 3's, character for character:
 * its calendar date, hours and minutes, optional seconds with any fraction, then Z or an offset
 * of two digits, an optional colon and two digits.
 *
 * Both keep the zod 3 message, so a caller refused for one of these two reasons reads the same
 * text as before. Moving either to the strict zod 4 form is a product decision about what the
 * engine accepts, and it is not made here.
 */

const DATE = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const TIME = `([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?`;
const OFFSET = `(Z|([+-]\\d{2}:?\\d{2}))`;

/** The zod 3 `datetime({ offset: true })` pattern. Exported for its test. */
export const OFFSET_DATETIME_PATTERN = new RegExp(`^${DATE}T${TIME}${OFFSET}$`);

/** An ISO 8601 timestamp with Z or a numeric offset, as zod 3 accepted it. */
export const OffsetDateTimeSchema = z.string().regex(OFFSET_DATETIME_PATTERN, 'Invalid datetime');

/** An 8-4-4-4-12 hex identifier, as zod 3's `uuid()` accepted it. */
export const UuidSchema = z.guid('Invalid uuid');
