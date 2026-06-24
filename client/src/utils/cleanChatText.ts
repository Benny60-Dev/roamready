/**
 * Shared cleaner for AI chat prose, used by BOTH the planning chat
 * (SessionPage) and the modify-trip panel (ModifyTripPanel) so the two can't
 * drift apart again (this codebase has a recurring duplicate-helper problem).
 *
 * It (1) removes the structured tag blocks each surface emits, then
 * (2) normalizes the model's stray markdown emphasis to plain text, then trims.
 *
 * ORDER MATTERS: the <itinerary>/<modify> JSON payloads are removed FIRST, so
 * the markdown pass only ever runs over conversational prose. The server already
 * strips the metadata tags (<origin>, <requestedNights>, <requestedStartDate>,
 * <rig>) before the client receives the message, so by this point nothing but
 * prose is left — the markdown normalization can never touch an <…> tag, and
 * tag PARSING (which happens elsewhere, on the raw content) is unaffected.
 *
 * Browser-safety: regexes use only lookAHEAD (?!…) and capture groups — NO
 * lookbehind — so they parse on older iOS Safari (<16.4) without throwing.
 */
export function cleanChatText(text: string): string {
  const withoutTags = text
    // Full + partial (streamed/truncated) structured blocks. Each surface emits
    // only one kind (<itinerary> in planning, <modify> in modify mode); stripping
    // the other is a harmless no-op, so one cleaner safely serves both bubbles.
    .replace(/<itinerary>[\s\S]*?<\/itinerary>/g, '')
    .replace(/<itinerary>[\s\S]*/g, '')
    .replace(/<modify\b[^>]*>[\s\S]*?<\/modify>/g, '')
    .replace(/<modify\b[^>]*>[\s\S]*/g, '')
    .trim()

  return stripMarkdownEmphasis(withoutTags)
    // Collapse oversized vertical gaps: the model sometimes emits 3+ consecutive
    // newlines, which render as a big blank space under whitespace-pre-wrap.
    // Squash any run of 3+ down to a normal paragraph break (exactly two), so
    // paragraphs keep ONE blank line between them but never a large gap. Single
    // and double newlines are left intact. Horizontal whitespace is untouched.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Conservatively strip the model's markdown emphasis to plain text. Only MATCHED
 * delimiter pairs are unwrapped — an unmatched or arithmetic asterisk ("5 * 5",
 * a lone "*"), an intra-word delimiter ("snake_case", "a*b"), and edge-spaced
 * delimiters ("** x **") are all left untouched.
 */
function stripMarkdownEmphasis(text: string): string {
  return text
    // Leading line markers: # / ## headings, > blockquotes, - • * bullets, and
    // "1." ordered lists — only when followed by whitespace, so a line that
    // starts with "*italic*" or "2 * 3" is NOT mistaken for a bullet marker.
    .replace(/^[ \t]*[#>\-•*]+[ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // Bold first (so ** is consumed before the single-* italic pass):
    // **text** / __text__. Content forbids the delimiter char itself, so it
    // can't span an inner pair — "**a** and **b**" unwraps to "a and b" rather
    // than swallowing the middle — and an unmatched ** (no closing) is left as-is.
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    // Italics: *text* / _text_. The delimiter must sit on a non-word boundary
    // and hug the content (opening not followed by space, content ending in a
    // non-space char, closing not followed by a word char), so "2 * 3", a stray
    // "*", "snake_case", and "a*b" are NOT unwrapped.
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]*?[^*\s])\*(?!\w)/g, '$1$2')
    .replace(/(^|[^_\w])_(?!\s)([^_\n]*?[^_\s])_(?!\w)/g, '$1$2')
}
