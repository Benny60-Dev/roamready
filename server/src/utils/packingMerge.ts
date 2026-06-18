/**
 * Regenerate carry-over for packing lists. Maps over the NEW list and
 * re-checks items whose names match a previously-checked item
 * (case-insensitive, trimmed), THEN appends back any user-added (custom) items
 * from the previous list — they won't appear in the freshly generated list, so
 * without this a Regenerate would silently drop them. Pure function so the
 * behaviors the controller guarantees are independently testable
 * (server/scripts/check-packing-merge.ts):
 *   - fresh trip (no prior list / nothing checked / no custom) → next returned
 *     untouched (same reference)
 *   - existing checks → full regenerated list with matching items re-checked
 *   - custom items → carried over (with their own checked state) and appended
 *     under their original category
 * The regenerated list's AI contents are authoritative for everything EXCEPT
 * user-added custom items, which are preserved on top; only the `checked` flags
 * are carried for AI items.
 */
export function mergePackedState(prev: unknown, next: any[]): any[] {
  // Single pass over the previous list: collect which names were checked and
  // any user-added (custom) items (tagged with their category for re-grouping).
  const prevChecked = new Set<string>()
  const customItems: Array<{ category: unknown; item: any }> = []
  if (Array.isArray(prev)) {
    for (const cat of prev as any[]) {
      for (const item of cat?.items ?? []) {
        const name = typeof item?.name === 'string' ? item.name.toLowerCase().trim() : null
        if (!name) continue
        if (item.checked === true) prevChecked.add(name)
        if (item.custom === true) customItems.push({ category: cat?.category, item })
      }
    }
  }

  // Re-apply checked-by-name carry-over to the new AI list. When nothing was
  // checked this is a no-op pass-through (same reference preserved for the
  // fresh-trip contract). Custom preservation below runs regardless.
  const merged = prevChecked.size === 0
    ? next
    : next.map(cat => ({
        ...cat,
        items: (cat?.items ?? []).map((item: any) =>
          typeof item?.name === 'string' && prevChecked.has(item.name.toLowerCase().trim())
            ? { ...item, checked: true }
            : item,
        ),
      }))

  if (customItems.length === 0) return merged

  // Append user-added items back in. Their own checked state rides along (the
  // original item object is reused). Appended to their original category if the
  // new list still has it, otherwise added as a new category. A custom item
  // whose name the new AI list already surfaced is skipped — the generated
  // suggestion supersedes the duplicate.
  const result = merged.map((cat: any) => ({ ...cat, items: [...(cat?.items ?? [])] }))
  for (const { category, item } of customItems) {
    const name = item.name.toLowerCase().trim()
    const dupe = result.some((cat: any) => (cat.items ?? []).some((i: any) =>
      typeof i?.name === 'string' && i.name.toLowerCase().trim() === name))
    if (dupe) continue
    const target = result.find((cat: any) => cat.category === category)
    if (target) target.items.push(item)
    else result.push({ category: category ?? 'My items', items: [item] })
  }
  return result
}

/**
 * Force checked:false on every item in a category list. Used by the saved-packing
 * flows (FR-SAVED-PACKING): a template is a STARTING POINT, not a packed state,
 * so checked marks are stripped both when a template is stored and again when its
 * items seed a trip. Pure; returns a new array (does not mutate the input).
 */
export function resetCheckedState(categories: unknown): any[] {
  if (!Array.isArray(categories)) return []
  return categories.map((cat: any) => ({
    ...cat,
    items: (cat?.items ?? []).map((item: any) => ({ ...item, checked: false })),
  }))
}
