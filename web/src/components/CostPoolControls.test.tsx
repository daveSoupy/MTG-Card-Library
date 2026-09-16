import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CostPoolFields, type CostPoolState } from './CostPoolControls.tsx';

function fakeState(overrides: Partial<CostPoolState> = {}): CostPoolState {
  return {
    costMethod: 'unknown',
    pickMethod: vi.fn(),
    fixedAmount: '',
    setFixedAmount: vi.fn(),
    boosterPrice: 4,
    pool: null,
    poolTotalStr: '',
    setPoolTotalStr: vi.fn(),
    commitTotal: vi.fn(),
    finishPool: vi.fn(),
    cancelPool: vi.fn(),
    pooled: false,
    ensurePoolOpen: vi.fn(),
    refreshPool: vi.fn(),
    ...overrides,
  };
}

describe('CostPoolFields', () => {
  it('renders the cost method select and reports a method change', () => {
    const state = fakeState();
    render(<CostPoolFields state={state} />);

    fireEvent.change(screen.getByDisplayValue('Unknown'), { target: { value: 'draft' } });
    expect(state.pickMethod).toHaveBeenCalledWith('draft');
  });

  it('shows the pool total input once a pooled method is selected', () => {
    const state = fakeState({ costMethod: 'draft', pooled: true, poolTotalStr: '12.00' });
    render(<CostPoolFields state={state} />);

    expect(screen.getByPlaceholderText('e.g. 12')).toBeInTheDocument();
  });

  it('the Cost label still labels the select, and its ? is not the label\'s control', () => {
    // A <button> is labelable, so a ? inside the <label> would have become
    // the control the label activates — every click on the caption opened
    // help, and the help backdrop's click re-opened it through the label.
    render(<CostPoolFields state={fakeState()} />);
    const select = screen.getByLabelText('Cost');
    expect(select.tagName).toBe('SELECT');

    fireEvent.click(screen.getByText('Cost'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Help: Cost pools/ }));
    const panel = screen.getByRole('dialog', { name: /^Cost pools/ });
    // Portalled: the overlay is a child of <body>, not of the entry bar.
    expect(document.querySelector('.help-overlay')!.parentElement).toBe(document.body);
    expect(within(panel).getByText(/re-divides every time the count/)).toBeInTheDocument();

    fireEvent.click(document.querySelector('.help-overlay')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
