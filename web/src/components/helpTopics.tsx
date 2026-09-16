import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HelpPanel, type HelpTopic } from './HelpPanel.tsx';
import { SYNTAX_HELP } from './SyntaxHelp.tsx';

/**
 * Phase 17. The reference panels behind every `?` in the app, in one place so
 * the topbar's help index can list all of them and a control can open its own
 * with one line. Each topic explains a single dense control — allocation,
 * cost pools, and so on — in the terms the UI beside it uses, and says only
 * what the code actually does: a panel that promises more than the feature
 * delivers is worse than none.
 *
 * `HelpButton` is the `?` beside a control; it owns its own open state so the
 * six panels are independent of each other and of the index. `HelpIndex` is
 * the topbar's list. Both render into HelpPanel.
 */

export type HelpTopicId =
  | 'syntax'
  | 'allocation'
  | 'costPools'
  | 'reopenPool'
  | 'colorIdentity'
  | 'limitedBasics'
  | 'importFormats';

export type { HelpTopic };

const P = ({ children }: { children: ReactNode }) => <p>{children}</p>;

export const HELP_TOPICS: Record<HelpTopicId, HelpTopic> = {
  syntax: SYNTAX_HELP,

  allocation: {
    title: 'From your collection, or need to buy',
    intro: 'A physical card can only be in one deck at a time, so the app tracks '
      + 'not just how many you own but how many are already spoken for.',
    columns: 1,
    sections: [
      {
        title: 'The two numbers',
        body: (
          <>
            <P>
              <strong>From your collection</strong> is how many copies in this deck the cards
              you own can cover. <strong>Need to buy</strong> is what is left once those and any
              proxies are counted. Basic lands are left out of both — they are never claimed,
              never missing, and never on a shopping list — unless you switch that off in
              Data → Settings.
            </P>
          </>
        ),
      },
      {
        title: 'Why a card shows as unavailable',
        body: (
          <>
            <P>
              What a deck can use is what you own, minus the copies other decks already hold,
              minus any copies flagged on a trade list. If <em>Atraxa</em> already holds your only
              copy, this deck sees zero available, and its row says <code>Atraxa has 1</code> rather
              than <code>Buy 1</code> — because that is a decision about which deck gets the card,
              not a purchase. The Contention panel in the deck header lists every card two decks are
              fighting over and can hand copies from one to the other.
            </P>
          </>
        ),
      },
      {
        title: 'Which decks claim copies',
        body: (
          <>
            <P>
              Only decks in <strong>Building</strong> or <strong>Assembled</strong> status lay claim
              to physical cards. A <strong>Brew</strong> holds a card list without reserving anything,
              so a half-formed idea never starves a deck you actually intend to build; a{' '}
              <strong>Disassembled</strong> deck has given its cards back. Flipping a deck to Brew
              releases every copy it held, immediately. So does deleting it.
            </P>
          </>
        ),
      },
      {
        title: 'Nothing here is set by hand',
        body: (
          <>
            <P>
              The claim is worked out from your collection and every deck's status, and is redone on
              every change — add a card to a box and a deck short of it picks the copy up; trade a card
              away and a deck holding it shows the shortfall. A deck that comes up short because
              another deck got there first is flagged, not blocked: you may be planning decks you never
              intend to have assembled at the same time.
            </P>
          </>
        ),
      },
    ],
  },

  costPools: {
    title: 'Cost pools: Box split and Draft',
    intro: 'When one price bought many cards, a pool spreads that price across all of them.',
    columns: 1,
    sections: [
      {
        title: 'What a pool is',
        body: (
          <P>
            Set <strong>Cost</strong> to <em>Box split</em> or <em>Draft</em> and the first card you add
            opens a pool. Its total — the price of the box, or what the draft cost to enter — is
            divided evenly across every copy added while it is open, and each copy carries that share
            as what you paid for it.
          </P>
        ),
      },
      {
        title: 'Why the per-card cost keeps changing',
        body: (
          <>
            <P>
              The share is simply <code>total ÷ copies</code>, so it re-divides every time the count
              changes. A $120 box entered as 300 cards is $0.40 each; add 100 more and every card in the
              pool, including the first 300, becomes $0.30. Changing a quantity mid-pool does the same
              thing in the other direction. What you paid never moves — only how it is spread.
            </P>
            <P>
              Editing the total in the <strong>Box total $</strong> or <strong>Draft cost $</strong>{' '}
              field re-divides too, as soon as you leave the field.
            </P>
          </>
        ),
      },
      {
        title: 'Finish and Cancel',
        body: (
          <P>
            A pool stays open until you tap <strong>Finish</strong> — across leaving the page, a reload,
            or coming back the next evening — so a box you sort over several sittings is still one
            pool. <strong>Finish</strong> closes it and keeps the cards. <strong>Cancel</strong> removes
            every card the pool added and closes it, which is the way out of a session started by
            mistake. A finished pool can be reopened later from Data → Recent imports.
          </P>
        ),
      },
      {
        title: 'Draft',
        body: (
          <P>
            A draft pool starts at 3× the booster price from Data → Settings, since that is what most
            drafts cost to enter; edit it if the venue charged something else. Cards a Draft or Sealed
            deck picks up through the deck builder join the open pool as well, so a draft entered from
            the deck costs what a draft entered from Collection costs.
          </P>
        ),
      },
    ],
  },

  reopenPool: {
    title: 'Reopening a closed cost pool',
    intro: 'Reopen and Undo sit side by side but do opposite things.',
    columns: 1,
    sections: [
      {
        title: 'Reopen',
        body: (
          <P>
            Makes a finished pool the open one again. Cards you then add from Collection → Add by set
            join that same batch, and its total re-divides across the old cards and the new. It is for
            a draft entered across two sittings, or a box you kept opening the next evening — the
            second half should share the first half's price, not get one of its own.
          </P>
        ),
      },
      {
        title: 'Undo',
        body: (
          <P>
            Removes the cards a batch added — every copy still in the collection from that import —
            and works on any import, not only pools. It is the way to take back a CSV that mapped its
            columns wrong, or a box entered against the wrong set.
          </P>
        ),
      },
      {
        title: 'What Reopen does not do',
        body: (
          <P>
            It does not change the total: edit that in the Cost field on Add by set once the pool is
            open again. It does not move cards, and it cannot apply to an ordinary CSV import, which
            has no total to divide. While the pool is open, the banner on Add by set shows it, and{' '}
            <strong>Finish</strong> closes it again.
          </P>
        ),
      },
    ],
  },

  colorIdentity: {
    title: 'Commander colour identity',
    intro: 'Why the picker hides some cards, and why a colour pill can seem to do nothing.',
    columns: 1,
    sections: [
      {
        title: 'The rule',
        body: (
          <P>
            A Commander deck may only hold cards whose colour identity fits inside the commander's
            (rule 903.4). Identity is not the same as colour: it counts every mana symbol on the card,
            including the ones in rules text and on the back face. Kenrith is a mono-white card with a
            five-colour identity, because his activated abilities use every colour. The app uses
            Scryfall's identity as printed rather than working it out again.
          </P>
        ),
      },
      {
        title: 'What the picker does',
        body: (
          <>
            <P>
              Once the deck has a commander, the picker only shows cards inside its identity —
              colourless cards fit every deck and stay. The colour pills narrow <em>within</em> that
              identity: red pills on a white-blue deck would leave nothing, so they have no effect
              rather than start offering illegal cards.
            </P>
            <P>
              In Browse, <code>id&lt;=wu</code> asks the same question for any query.
            </P>
          </>
        ),
      },
      {
        title: 'A red-flagged card in the list',
        body: (
          <P>
            A card already in the deck that sits outside the identity — after swapping commanders, or
            from an import — is marked as an error in the deck's issues and on its row. The maybeboard
            is a scratch pad and is never checked. Under Oathbreaker only the planeswalker sets the
            identity; the signature spell must fit inside it.
          </P>
        ),
      },
    ],
  },

  limitedBasics: {
    title: 'Why a basic land was not added to your collection',
    intro: 'The one silent exception when building a Draft or Sealed deck.',
    columns: 1,
    sections: [
      {
        title: 'Limited decks acquire as they go',
        body: (
          <P>
            In a Draft or Sealed deck, adding a card in the picker also adds a copy to your collection,
            allocated to this deck, and it joins the open cost pool if there is one. The cards came
            out of packs you paid for, so recording the deck is recording the purchase.
          </P>
        ),
      },
      {
        title: 'Basics are the exception',
        body: (
          <P>
            In paper limited, basic lands come from the venue's land station, not out of the packs.
            So a Mountain in a draft deck is a deck slot and nothing more: no collection row, and no
            share of the draft's cost. Non-basic lands from the packs are ordinary cards and are added
            like everything else.
          </P>
        ),
      },
      {
        title: 'If you did take the basics home',
        body: (
          <P>
            Add them from Collection → Add by set like any other card. While “basic lands are exempt”
            is on in Data → Settings they are never claimed by a deck anyway, so the count only
            matters for what you own.
          </P>
        ),
      },
    ],
  },

  importFormats: {
    title: 'What the importer understands',
    intro: 'Every site exports a slightly different dialect; the common ones all work.',
    columns: 2,
    sections: [
      {
        title: 'Decklist lines',
        entries: [
          { syntax: '4 Lightning Bolt', meaning: 'A count, then the name' },
          { syntax: '4x Lightning Bolt', meaning: 'A trailing x on the count is fine' },
          { syntax: '2 Sol Ring (CMR) 472', meaning: 'A set code and collector number pick the printing' },
          { syntax: '2 Sol Ring [CMR] 472', meaning: 'Square brackets work too; the number is optional' },
          { syntax: 'SB: 2 Pyroblast', meaning: 'Sideboard, marked line by line (Cockatrice, deckstats)' },
          { syntax: '1 Atraxa, Praetors\' Voice *CMDR*', meaning: 'Commander marked inline (Moxfield, Archidekt)' },
          { syntax: '// a note  ·  # a note', meaning: 'Ignored, at the start of a line only — Fire // Ice is a card' },
        ],
      },
      {
        title: 'Sections',
        entries: [
          { syntax: 'Deck  ·  Mainboard', meaning: 'Main deck' },
          { syntax: 'Sideboard', meaning: 'Sideboard' },
          { syntax: 'Commander  ·  Command zone', meaning: 'Command zone' },
          { syntax: 'Maybeboard  ·  Considering', meaning: 'Maybeboard' },
          { syntax: '(a blank line)', meaning: 'MTGO convention: the first blank line after the cards begin starts the sideboard, when no header has said otherwise' },
        ],
      },
      {
        title: 'Collection CSV files',
        body: (
          <P>
            An export from Deckbox, ManaBox, TCGplayer, Moxfield or a spreadsheet of your own. Columns
            are matched by their header, and you correct the mapping before anything is written.
            Quoted fields are handled, so a name with a comma in it stays one card.
          </P>
        ),
        entries: [
          { syntax: 'Name  ·  Card', meaning: 'Card name' },
          { syntax: 'Set  ·  Edition', meaning: 'Set name' },
          { syntax: 'Set code  ·  Edition code', meaning: 'Set code' },
          { syntax: 'Collector number  ·  CN', meaning: 'Collector number' },
          { syntax: 'Quantity  ·  Count  ·  Qty', meaning: 'How many' },
          { syntax: 'Foil  ·  Finish', meaning: 'Foil or not' },
          { syntax: 'Condition  ·  Language', meaning: 'Condition; language' },
          { syntax: 'Price  ·  Paid', meaning: 'What you paid, per copy' },
        ],
      },
    ],
  },
};

/** The order the index lists them in: the general reference first, then by page. */
export const HELP_TOPIC_ORDER: HelpTopicId[] = [
  'syntax', 'allocation', 'colorIdentity', 'limitedBasics', 'costPools', 'reopenPool', 'importFormats',
];

export function HelpTopicPanel({
  topic,
  onClose,
  onBack,
}: {
  topic: HelpTopicId;
  onClose: () => void;
  /** Present when opened from the index, so a reader can go back to the list. */
  onBack?: () => void;
}) {
  const content = HELP_TOPICS[topic];
  return (
    <HelpPanel
      title={content.title}
      intro={content.intro}
      sections={content.sections}
      onClose={onClose}
      onBack={onBack}
      className={content.columns === 1 ? 'help-single' : undefined}
    />
  );
}

/**
 * The `?` beside a control. Self-contained: click opens the topic's panel,
 * Close / Escape / backdrop closes it, and no other panel is involved.
 *
 * The panel is portalled to <body>: a ? can sit inside a sticky bar with its
 * own z-index, or inside another overlay, and the panel must paint above all
 * of it and not bubble native clicks into whatever wraps the button.
 */
export function HelpButton({ topic }: { topic: HelpTopicId }) {
  const [open, setOpen] = useState(false);
  const { title } = HELP_TOPICS[topic];
  return (
    <>
      <button
        type="button"
        className="help-btn"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={`Help: ${title}`}
      >?</button>
      {open && createPortal(
        <HelpTopicPanel topic={topic} onClose={() => setOpen(false)} />,
        document.body,
      )}
    </>
  );
}

/** The topbar's list of every panel, for reading ahead rather than discovering as you go. */
export function HelpIndex({
  onOpen,
  onClose,
}: {
  onOpen: (topic: HelpTopicId) => void;
  onClose: () => void;
}) {
  return (
    <HelpPanel
      title="Help"
      intro="Each of these also opens from a ? beside the control it explains."
      onClose={onClose}
      className="help-single"
    >
      <ul className="help-index">
        {HELP_TOPIC_ORDER.map((id) => (
          <li key={id}>
            <button type="button" className="help-index-row" onClick={() => onOpen(id)}>
              <strong>{HELP_TOPICS[id].title}</strong>
              <span>{HELP_TOPICS[id].intro}</span>
            </button>
          </li>
        ))}
      </ul>
    </HelpPanel>
  );
}
