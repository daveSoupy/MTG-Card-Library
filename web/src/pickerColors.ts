/**
 * The colour filter for the deck picker.
 *
 * The picker has two colour constraints that both have to hold: the commander's
 * colour identity (a card outside it is illegal on arrival) and whatever the
 * user clicked to narrow the search. The server's `colors` param carries only
 * one set, so they are combined by intersection — narrowing within the identity.
 *
 * An entirely off-identity pick (red pills on a WUBG deck) would intersect to
 * nothing; rather than drop the identity guard and start offering illegal cards,
 * that falls back to the identity and the impossible pick simply has no effect.
 */
export function effectivePickerColors(
  picks: string[],
  identity: string[] | null,
): string[] | undefined {
  if (picks.length === 0) return identity ?? undefined;
  if (identity === null) return picks;

  const within = picks.filter((c) => identity.includes(c));
  return within.length > 0 ? within : identity;
}
