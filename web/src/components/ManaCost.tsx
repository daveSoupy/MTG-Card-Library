import { dotClass, manaDisplay } from '../mana.ts';

/**
 * A mana value and its colours: `5 ●●` rather than `{3}{W}{W}`.
 *
 * Renders nothing at all for a card with no cost — a land's cell stays empty
 * instead of claiming it costs zero.
 *
 * The wrapper carries the exact printed cost as its tooltip, so the compressed
 * form never loses anything: `{X}` spells, hybrids and the far half of a split
 * card are all still one hover away.
 */
export function ManaCost({
  cost,
  cmc,
  className = 'mana',
}: {
  cost: string | null;
  cmc: number;
  /** `cmana` in the card grids, which style the cell differently. */
  className?: string;
}) {
  const { value, dots, title } = manaDisplay(cost, cmc);
  if (value === null) return null;

  return (
    <span className={className} title={title ?? undefined}>
      <span className="mv">{value}</span>
      {dots.length > 0 && (
        <span className="mana-dots">
          {dots.map((colors, index) => (
            <span
              // Pips repeat by design ({W}{W}), so position is the only stable
              // key available.
              key={index}
              className={`mana-dot ${dotClass(colors)}`}
              data-colors={colors.join('')}
            />
          ))}
        </span>
      )}
    </span>
  );
}
