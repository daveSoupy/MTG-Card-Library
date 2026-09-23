import { useState } from 'react';
import type { NamedList } from '../api.ts';

/**
 * How many copies of one lot to put on which trade list.
 *
 * One copy by default, not the whole lot: with trade-listed copies counted out
 * of what is free to build with, listing all four of a card quietly takes all
 * four away from every deck that wanted one. The count is what the listing
 * will say — listing a lot already on that list sets its count, not adds to it.
 */
export function ListForTradeForm({ max, lists, busy, onSubmit, onCancel }: {
  /** The lot's quantity: more than that cannot be promised from it. */
  max: number;
  lists: NamedList[];
  busy?: boolean;
  onSubmit: (listId: number, quantity: number) => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [listId, setListId] = useState<number | null>(
    (lists.find((l) => l.is_default) ?? lists[0])?.id ?? null,
  );
  const valid = listId !== null && Number.isInteger(quantity) && quantity >= 1 && quantity <= max;

  return (
    <form
      className="lot-trade"
      onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit(listId!, quantity); }}
    >
      <label>
        List
        <input
          type="number" min={1} max={max} value={quantity}
          aria-label="Copies to list for trade"
          onChange={(e) => setQuantity(Number(e.target.value))}
        />
        of {max} on
      </label>
      <select
        aria-label="Trade list"
        value={listId ?? ''}
        onChange={(e) => setListId(Number(e.target.value))}
      >
        {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <button className="linkish" type="submit" disabled={!valid || busy}>
        {busy ? 'Listing…' : 'List'}
      </button>
      <button className="linkish" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
    </form>
  );
}
