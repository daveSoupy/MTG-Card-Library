import { HelpPanel, type HelpSection, type HelpTopic } from './HelpPanel.tsx';

/**
 * In-app reference for the search syntax.
 *
 * The app accepts Scryfall-style queries but had no way to discover that, which
 * made most of the search layer invisible. Only the operators actually
 * implemented are listed — documenting more than works would be worse than
 * documenting nothing. The overlay, card and dismissal live in HelpPanel
 * (Phase 17); this file is the content.
 */

const SECTIONS: HelpSection[] = [
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
      {
        syntax: 'category:removal  ·  cat:ramp',
        meaning: 'What a card does — removal, draw, ramp, recursion, protection, '
          + 'tutor, sweeper, counterspell',
      },
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
      { syntax: 'is:anynumber  ·  is:copylimit',
        meaning: 'A deck can have any number of them; that plus printed caps like Nazgûl' },
      { syntax: 'is:ub  ·  -is:ub',
        meaning: 'Universes Beyond crossovers; shown unless you exclude them' },
    ],
  },
  {
    title: 'Your collection',
    entries: [
      { syntax: 'owned  ·  owned>=2  ·  owned:0',
        meaning: 'Copies you have, across every printing and box' },
      { syntax: 'available  ·  available>=1',
        meaning: 'Copies no deck has claimed and no trade list has promised away' },
      { syntax: 'loc:"Blue Tackle Box"', meaning: 'Has a copy in that storage location' },
      { syntax: 'indeck  ·  -indeck', meaning: 'Used by some deck; used by none' },
      { syntax: '-indeck owned>=1', meaning: 'Dead inventory — owned, and in no deck' },
      { syntax: 'deck:Atraxa', meaning: 'Used by that deck' },
      { syntax: 'want  ·  want:Grails', meaning: 'On any want list, or that one' },
      { syntax: 'fortrade  ·  tradelist:"Bulk trades"', meaning: 'Flagged to trade away' },
    ],
  },
  {
    title: 'Combining',
    entries: [
      { syntax: 't:creature c:rg cmc<=3', meaning: 'Terms combine with AND' },
      { syntax: '-t:creature', meaning: 'A leading minus negates any term' },
      { syntax: 'not:owned', meaning: 'not: inverts an is: property' },
      { syntax: 'available>=1 c:ur t:instant cmc<=2',
        meaning: 'Collection terms are ordinary terms — they narrow, never replace' },
    ],
  },
];

/** The topic as the help index lists it (helpTopics.tsx). */
export const SYNTAX_HELP: HelpTopic = {
  title: 'Search syntax',
  intro: 'Everything runs against the local card database, so searches never touch the network.',
  sections: SECTIONS,
  columns: 2,
};

export function SyntaxHelp({ onClose, onBack }: { onClose: () => void; onBack?: () => void }) {
  return (
    <HelpPanel
      title={SYNTAX_HELP.title}
      intro={SYNTAX_HELP.intro}
      sections={SYNTAX_HELP.sections}
      onClose={onClose}
      onBack={onBack}
    />
  );
}
