import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CardDetailPane } from './CardDetailPane.tsx';
import type { CardDetail, CardPrinting } from '../api.ts';

const printing = (over: Partial<CardPrinting>): CardPrinting => ({
  id: 'p1', setCode: 'tst', setName: 'Test Set', collectorNumber: '1', rarity: 'common',
  releasedAt: '2020-01-01', priceUsd: null, priceUsdFoil: null, imageNormal: null,
  scryfallUri: null, tcgplayerId: null, isDigital: false, isPromo: false, promoTypes: [],
  ownedQuantity: 0,
  ...over,
});

const card: CardDetail = {
  oracleId: 'o1', name: 'Sol Ring', manaCost: '{1}', cmc: 1, typeLine: 'Artifact',
  power: null, toughness: null, loyalty: null, colors: '', colorIdentity: '',
  rarity: 'uncommon', setCode: 'tst', setName: 'Test Set', collectorNumber: '1',
  imageSmall: null, imageNormal: null, priceUsd: null, priceUsdFoil: null,
  printingId: 'p1', ownedQuantity: 0, printingCount: 2,
  layout: 'normal', oracleText: 'Add {C}{C}.', flavorText: null, artist: null,
  keywords: [], isReserved: false, canBeCommander: false, deckCopyLimit: null,
  edhrecRank: null, frontImage: null, backImage: null, faces: [],
  printings: [
    printing({ id: 'p1', setCode: 'tst', setName: 'Test Set', collectorNumber: '1' }),
    printing({ id: 'p2', setCode: 'oth', setName: 'Other Set', collectorNumber: '99' }),
  ],
  legalities: [], rulings: [],
};

const api = vi.hoisted(() => ({
  fetchCard: vi.fn(),
  fetchCardHolders: vi.fn(async () => null),
}));
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  ...api,
}));

describe('CardDetailPane — Add to collection', () => {
  it('opens on the printing selected in the pane, not always the default', async () => {
    api.fetchCard.mockResolvedValue(card);
    const onAddToCollection = vi.fn();
    render(
      <CardDetailPane
        oracleId="o1"
        floating={false}
        onClose={vi.fn()}
        onAddToCollection={onAddToCollection}
      />,
    );
    await screen.findByText('Sol Ring');

    // Default printing first.
    fireEvent.click(screen.getByRole('button', { name: '+ Collection' }));
    expect(onAddToCollection).toHaveBeenLastCalledWith('o1', 'p1');

    // Switch to the other printing in the list, then add again.
    fireEvent.click(screen.getByText(/Other Set/));
    fireEvent.click(screen.getByRole('button', { name: '+ Collection' }));
    expect(onAddToCollection).toHaveBeenLastCalledWith('o1', 'p2');
  });

  it('renders no button at all when the host offers no way to add', async () => {
    api.fetchCard.mockResolvedValue(card);
    render(<CardDetailPane oracleId="o1" floating={false} onClose={vi.fn()} />);
    await screen.findByText('Sol Ring');
    expect(screen.queryByRole('button', { name: '+ Collection' })).toBeNull();
  });
});
