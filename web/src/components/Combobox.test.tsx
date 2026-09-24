import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Combobox } from './Combobox.tsx';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

describe('Combobox keyboard support', () => {
  it('has combobox/listbox ARIA roles', () => {
    render(<Combobox options={OPTIONS} value="" onChange={vi.fn()} placeholder="Find a set" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('ArrowDown moves the highlight and Enter picks the highlighted option', () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTIONS} value="" onChange={onChange} placeholder="Find a set" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // Alpha -> Beta
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // Beta -> Gamma
    fireEvent.keyDown(input, { key: 'ArrowUp' });   // Gamma -> Beta
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('ArrowDown alone opens a closed list without picking anything', () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTIONS} value="" onChange={onChange} placeholder="Find a set" />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('typing to filter resets the highlight to the first match', () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTIONS} value="" onChange={onChange} placeholder="Find a set" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // highlight -> Beta
    fireEvent.change(input, { target: { value: 'g' } }); // only Gamma matches
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('Enter with the list closed does nothing', () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTIONS} value="" onChange={onChange} placeholder="Find a set" />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
