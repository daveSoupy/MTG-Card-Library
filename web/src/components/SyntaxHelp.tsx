import { useEffect } from 'react';

/**
 * In-app reference for the search syntax.
 *
 * The app accepts Scryfall-style queries but had no way to discover that, which
 * made most of the search layer invisible. Only the operators actually
 * implemented are listed — documenting more than works would be worse than
 * documenting nothing.
 */

interface Entry {
  syntax: string;
  meaning: string;
}

const SECTIONS: Array<{ title: string; entries: Entry[] }> = [
  {
    title: 'Text',
    entries: [
      { syntax: 'lightning bolt', meaning: 'Words with no prefix match the name and rules text' },
      { syntax: '"draw a card"', meaning: 'Quotes keep a phrase together' },
      { syntax: 'name:bolt  ·  n:bolt', meaning: 'Name contains' },
      { syntax: 'oracle:flying  ·  o:flying', meaning: 'Rules text contains, including the back face' },
      { syntax: 'type:creature  ·  t:goblin', meaning: 'Type line contains' },
    ],
  },
  {
    title: 'Colour',
    entries: [
      { syntax: 'c:rg', meaning: 'Colours include both red and green' },
      { syntax: 'c:c', meaning: 'Colourless' },
      { syntax: 'c:azorius', meaning: 'Guild and shard names work too' },
      { syntax: 'id<=wu', meaning: 'Colour identity fits inside white-blue — the Commander question' },
      { syntax: 'c=rg', meaning: 'Exactly these colours, nothing more' },
    ],
  },
  {
    title: 'Numbers',
    entries: [
      { syntax: 'cmc<=3  ·  mv>=5', meaning: 'Mana value, with =, !=, <, <=, > and >=' },
      { syntax: 'pow>=4', meaning: 'Power' },
      { syntax: 'tou<2', meaning: 'Toughness' },
      { syntax: 'loy=3', meaning: 'Loyalty' },
      { syntax: 'year>=2020', meaning: 'Release year' },
    ],
  },
  {
    title: 'Printing',
    entries: [
      { syntax: 'set:blb  ·  e:blb', meaning: 'Printed in a set' },
      { syntax: 'rarity:mythic  ·  r:m', meaning: 'Rarity' },
      { syntax: 'artist:"Rebecca Guay"  ·  a:guay', meaning: 'Artist' },
      { syntax: 'layout:split', meaning: 'Card layout' },
    ],
  },
  {
    title: 'Legality',
    entries: [
      { syntax: 'f:modern  ·  legal:commander', meaning: 'Legal (or restricted) in a format' },
      { syntax: 'banned:legacy', meaning: 'Banned in a format' },
      { syntax: 'restricted:vintage', meaning: 'Restricted in a format' },
      { syntax: 'is:playable  ·  is:unplayable',
        meaning: 'Cards legal in no format — Un-sets, playtest cards — are hidden by default' },
    ],
  },
  {
    title: 'Properties',
    entries: [
      { syntax: 'is:commander', meaning: 'Can be a commander' },
      { syntax: 'is:owned', meaning: 'In your collection' },
      { syntax: 'is:legendary  ·  is:reserved', meaning: 'Legendary; on the Reserved List' },
      { syntax: 'is:dfc  ·  is:split', meaning: 'Double-faced; split card' },
      { syntax: 'is:multicolor  ·  is:colorless', meaning: 'Gold; colourless' },
      { syntax: 'is:land  ·  is:creature  ·  is:spell', meaning: 'Broad type shortcuts' },
      { syntax: 'is:partner  ·  is:background', meaning: 'Can pair as a commander' },
      { syntax: 'is:digital  ·  is:paper', meaning: 'Alchemy and Arena-only cards are hidden by default' },
      { syntax: 'is:hybrid', meaning: 'Hybrid mana in the cost' },
      { syntax: 'is:ub  ·  -is:ub',
        meaning: 'Universes Beyond crossovers; shown unless you exclude them' },
    ],
  },
  {
    title: 'Combining',
    entries: [
      { syntax: 't:creature c:rg cmc<=3', meaning: 'Terms combine with AND' },
      { syntax: '-t:creature', meaning: 'A leading minus negates any term' },
      { syntax: 'not:owned', meaning: 'not: inverts an is: property' },
    ],
  },
];

export function SyntaxHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="syntax-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>Search syntax</h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
        <p className="note">
          Everything runs against the local card database, so searches never touch the network.
        </p>

        <div className="syntax-body">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              {section.entries.map((entry) => (
                <div className="syntax-row" key={entry.syntax}>
                  <code>{entry.syntax}</code>
                  <span>{entry.meaning}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
