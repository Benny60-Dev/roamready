/**
 * Regenerate carry-over for packing lists. Maps over the NEW list and
 * re-checks items whose names match a previously-checked item
 * (case-insensitive, trimmed). Pure function so the two behaviors the
 * controller guarantees are independently testable
 * (server/scripts/check-packing-merge.ts):
 *   - fresh trip (no prior list / nothing checked) → next returned untouched
 *   - existing checks → full regenerated list with matching items re-checked
 * Never filters or intersects — the regenerated list's contents are
 * authoritative; only the `checked` flags are carried.
 */
export function mergePackedState(prev: unknown, next: any[]): any[] {
  const prevChecked = new Set<string>()
  if (Array.isArray(prev)) {
    for (const cat of prev as any[]) {
      for (const item of cat?.items ?? []) {
        if (item?.checked === true && typeof item?.name === 'string') {
          prevChecked.add(item.name.toLowerCase().trim())
        }
      }
    }
  }
  if (prevChecked.size === 0) return next
  return next.map(cat => ({
    ...cat,
    items: (cat?.items ?? []).map((item: any) =>
      typeof item?.name === 'string' && prevChecked.has(item.name.toLowerCase().trim())
        ? { ...item, checked: true }
        : item,
    ),
  }))
}
