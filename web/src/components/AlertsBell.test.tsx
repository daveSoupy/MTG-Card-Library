import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AlertsBell } from './AlertsBell.tsx';
import type { Alert } from '../api.ts';

const api = vi.hoisted(() => ({
  fetchAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(async () => ({ activeCount: 0 })),
  resolveAlert: vi.fn(async () => ({ activeCount: 0 })),
  acknowledgeAllAlerts: vi.fn(async () => ({ changed: 0, activeCount: 0 })),
  resolveAllAlerts: vi.fn(async () => ({ changed: 0, activeCount: 0 })),
}));

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  ...api,
}));

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 1, kind: 'allocation_conflict', state: 'active', subjectType: null, subjectId: null,
  title: 'Not enough Sol Ring to go round', message: 'First has it', payload: { name: 'Sol Ring' },
  createdAt: '', acknowledgedAt: null,
  ...over,
});

describe('AlertsBell', () => {
  beforeEach(() => {
    api.fetchAlerts.mockReset();
    api.acknowledgeAllAlerts.mockReset().mockResolvedValue({ changed: 0, activeCount: 0 });
    api.resolveAllAlerts.mockReset().mockResolvedValue({ changed: 0, activeCount: 0 });
  });

  it('groups active alerts by kind and offers a per-kind Dismiss when more than one', async () => {
    api.fetchAlerts.mockImplementation(async (state?: string) => (state === 'active'
      ? { alerts: [alert({ id: 1 }), alert({ id: 2 })], activeCount: 2 }
      : { alerts: [], activeCount: 0 }));

    render(<AlertsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    await waitFor(() => expect(screen.getByText('Deck conflicts')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Dismiss (2)' })).toBeTruthy();
  });

  it('Dismiss all resolves every active alert with no kind filter', async () => {
    api.fetchAlerts.mockImplementation(async (state?: string) => (state === 'active'
      ? { alerts: [alert()], activeCount: 1 }
      : { alerts: [], activeCount: 0 }));

    render(<AlertsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss all' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    await waitFor(() => expect(api.resolveAllAlerts).toHaveBeenCalledWith(undefined));
  });

  it('clicking a linked alert navigates and closes the panel', async () => {
    api.fetchAlerts.mockImplementation(async (state?: string) => (state === 'active'
      ? { alerts: [alert()], activeCount: 1 }
      : { alerts: [], activeCount: 0 }));
    const onNavigate = vi.fn();

    render(<AlertsBell onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    await waitFor(() => expect(screen.getByText(alert().title)).toBeTruthy());
    fireEvent.click(screen.getByText(alert().title));
    expect(onNavigate).toHaveBeenCalledWith({ name: 'browse', q: 'Sol Ring' });
  });

  it('explains Seen vs Dismiss whenever there is something active to act on', async () => {
    api.fetchAlerts.mockImplementation(async (state?: string) => (state === 'active'
      ? { alerts: [alert()], activeCount: 1 }
      : { alerts: [], activeCount: 0 }));

    render(<AlertsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    await waitFor(() => expect(screen.getByText(/keeps it below, in Recent/)).toBeTruthy());
  });
});
