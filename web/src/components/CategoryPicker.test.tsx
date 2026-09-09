import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CategoryPicker } from './CategoryPicker.tsx';

const labels = {
  removal: 'Removal',
  draw: 'Card draw',
  ramp: 'Ramp',
  sweeper: 'Board wipes',
};

function picker(value: string | null, onChange = vi.fn()) {
  const view = render(
    <CategoryPicker value={value} labels={labels} onChange={onChange} cardName="Sol Ring" />,
  );
  fireEvent.click(screen.getByLabelText('Categories for Sol Ring'));
  return { ...view, onChange };
}

/** Nothing is saved until the list closes — that is what makes it a checklist. */
const done = () => fireEvent.click(screen.getByRole('button', { name: 'Done' }));

const box = (label: string) =>
  screen.getByRole('checkbox', { name: new RegExp(`^${label}`) });

describe('CategoryPicker', () => {
  it('reads as a menu rather than a text field', () => {
    picker(null);
    const control = screen.getByLabelText('Categories for Sol Ring');
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(control.getAttribute('aria-haspopup')).toBe('true');
    expect(control.textContent).toContain('▾');
  });

  it('offers only the categories the server resolves — nothing to type', () => {
    const { container } = picker(null);
    expect(screen.getAllByRole('checkbox').map((b) => b.parentElement?.textContent?.trim()))
      .toEqual(['Removal', 'Card draw', 'Ramp', 'Board wipes']);
    // Free text is gone: a category is only worth anything if a template row
    // counts it, and a typo never could.
    expect(container.querySelector('input[type="text"], input:not([type])')).toBeNull();
    expect(container.querySelector('datalist')).toBeNull();
  });

  it('ticks what the card already carries, by key or by label', () => {
    picker('ramp, Board wipes');
    expect(box('Ramp')).toBeChecked();
    expect(box('Board wipes')).toBeChecked();
    expect(box('Removal')).not.toBeChecked();
  });

  it('stores the display name, which is what a group heading shows', () => {
    const { onChange } = picker(null);
    fireEvent.click(box('Board wipes'));
    done();
    expect(onChange).toHaveBeenCalledWith('Board wipes');
  });

  it('saves nothing until the list closes', () => {
    // Saving per tick wrote to the deck mid-interaction. With the list grouped
    // by category that moved the row into another group, remounting this
    // control and closing it — so only one box could ever be ticked.
    const { onChange } = picker(null);
    fireEvent.click(box('Ramp'));
    fireEvent.click(box('Card draw'));
    expect(onChange).not.toHaveBeenCalled();

    done();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('Ramp, Card draw');
  });

  it('accumulates rather than replacing, so a card can satisfy two rows', () => {
    const { onChange } = picker('Ramp');
    fireEvent.click(box('Card draw'));
    done();
    expect(onChange).toHaveBeenCalledWith('Ramp, Card draw');
  });

  it('ticking and unticking the same box saves nothing at all', () => {
    const { onChange } = picker('Ramp');
    fireEvent.click(box('Card draw'));
    fireEvent.click(box('Card draw'));
    done();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('unticking the last one clears the override rather than storing blank', () => {
    const { onChange } = picker('Ramp');
    fireEvent.click(box('Ramp'));
    done();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('closes and saves on Escape', () => {
    const { onChange } = picker(null);
    fireEvent.click(box('Ramp'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith('Ramp');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows a value from before the checklist so it can be removed', () => {
    // Nothing offers "My Wincons" any more; without this it would be invisible
    // and silently dropped by the next edit.
    const { onChange } = picker('My Wincons, Ramp');
    const legacy = screen.getByRole('checkbox', { name: /My Wincons/ });
    expect(legacy).toBeChecked();

    fireEvent.click(legacy);
    done();
    expect(onChange).toHaveBeenCalledWith('Ramp');
  });

  it('summarises the selection on the closed control', () => {
    render(<CategoryPicker value="Ramp, Removal" labels={labels} onChange={vi.fn()} cardName="Bolt" />);
    expect(screen.getByLabelText('Categories for Bolt')).toHaveTextContent('Ramp, Removal');
  });
});
