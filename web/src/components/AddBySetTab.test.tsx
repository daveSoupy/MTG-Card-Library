import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddBySetTab } from './AddBySetTab.tsx';
import type { StorageLocation } from '../api.ts';

const location: StorageLocation = {
  id: 1, name: 'Binder A', kind: 'binder', notes: null, is_default: 1,
  is_archived: 0, card_count: 0, distinct_printings: 0, value_usd: 0,
};

describe('AddBySetTab', () => {
  it('renders the empty state and toggles "Hide ones I have"', () => {
    render(<AddBySetTab sets={[]} locations={[location]} onChanged={vi.fn()} />);

    expect(screen.getByText(/Pick a set to work through it/)).toBeInTheDocument();

    const checkbox = screen.getByLabelText('Hide ones I have') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });
});
