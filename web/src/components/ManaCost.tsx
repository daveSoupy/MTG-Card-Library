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

/**
 * The cost as printed — `{3}{G}` as a 3 pip and a green G pip — for places
 * with room to read it, like the card detail pane. `3 ●` reads to a player
 * like {3}{G}{G}-ish guesswork; this is what the card actually says. Dense
 * rows keep `ManaCost`'s compact form.
 */
export function ManaSymbols({ cost }: { cost: string | null }) {
  if (!cost || cost.trim() === '') return null;
  const faces = cost.split('//').map((face) => face.match(/\{[^}]+\}/g) ?? []);
  return (
    <span className="mana-symbols" title={cost} aria-label={`Mana cost ${cost}`}>
      {faces.map((symbols, face) => (
        <span className="mana-face" key={face}>
          {face > 0 && <span className="mana-split" aria-hidden="true">//</span>}
          {symbols.map((raw, index) => {
            const inner = raw.slice(1, -1);
            const colors = inner.split('/').filter((part) => 'WUBRG'.includes(part) && part.length === 1);
            return (
              <span key={index} className={`mana-pip ${dotClass(colors)}`} aria-hidden="true">{inner}</span>
            );
          })}
        </span>
      ))}
    </span>
  );
}
