import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListForTradeForm } from './ListForTradeForm.tsx';
import type { NamedList } from '../api.ts';

const LISTS: NamedList[] = [
  { id: 1, name: 'Binder trades', description: null, is_default: 0, sort_order: 0 },
  { id: 2, name: 'For trade', description: null, is_default: 1, sort_order: 1 },
];

describe('ListForTradeForm', () => {
  it('defaults to one copy on the default list, not the whole lot', () => {
    const onSubmit = vi.fn();
    render(<ListForTradeForm max={4} lists={LISTS} onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByLabelText('Copies to list for trade')).toHaveValue(1);
    expect(screen.getByLabelText('Trade list')).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onSubmit).toHaveBeenCalledWith(2, 1);
  });

  it('sends the chosen quantity and list', () => {
    const onSubmit = vi.fn();
    render(<ListForTradeForm max={4} lists={LISTS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Copies to list for trade'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Trade list'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onSubmit).toHaveBeenCalledWith(1, 3);
  });

  it('will not promise more copies than the lot holds', () => {
    const onSubmit = vi.fn();
    render(<ListForTradeForm max={2} lists={LISTS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Copies to list for trade'), { target: { value: '3' } });
    expect(screen.getByRole('button', { name: 'List' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
