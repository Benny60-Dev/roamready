/** Canonical feedback reference code — "[FB-XXXX]" in email subjects/bodies
 *  and the admin UI's Find-in-Gmail search. Server and client MUST derive the
 *  identical ref from the same id: this file and server/src/utils/fbRef.ts
 *  are intentionally byte-identical twins (no shared package exists between
 *  the two builds) — change BOTH or threading/search breaks. */
export const fbRef = (id: string) => `FB-${id.slice(-4).toUpperCase()}`
