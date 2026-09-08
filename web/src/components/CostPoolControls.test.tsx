import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
