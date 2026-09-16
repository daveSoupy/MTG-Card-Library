import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PairPhonePanel } from './PairPhonePanel.tsx';
import { fetchInstance, type InstanceInfo } from '../api.ts';

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  fetchInstance: vi.fn(),
}));

const instance = vi.mocked(fetchInstance);

const SHARED: InstanceInfo = {
  instanceId: 'ab12cd34-0000-4000-8000-000000000000',
  name: 'Daves-Mac',
  version: '1.0.0',
  port: 8080,
  addresses: ['192.168.1.20', '100.101.102.103'],
  mdnsName: 'mtg-library-ab12.local',
};

/**
 * Phase 33's panel has two states and one rule: a QR only while the server
 * has an address another device can reach. jsdom's page lives at localhost,
 * which is the desktop app's own window, so the "sharing off" sentence here
 * is the one that names the tray toggle.
 */
describe('PairPhonePanel', () => {
  beforeEach(() => { instance.mockReset(); });

  it('shows the QR, every address, the .local name and the home-screen line while sharing is on', async () => {
    instance.mockResolvedValue(SHARED);
    render(<PairPhonePanel />);

    const qr = await screen.findByRole('img', { name: /QR code/ });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);

    expect(screen.getByText('http://192.168.1.20:8080/')).toBeInTheDocument();
    expect(screen.getByText('http://100.101.102.103:8080/')).toBeInTheDocument();
    expect(screen.getByText('http://mtg-library-ab12.local:8080/')).toBeInTheDocument();
    expect(screen.getByText(/On your phone, open this and choose/)).toHaveTextContent('Add to Home Screen');
    expect(screen.queryByText(/Sharing is off/)).toBeNull();
  });

  it('explains the toggle instead, with no QR, when the server has no address to offer', async () => {
    instance.mockResolvedValue({ ...SHARED, addresses: [] });
    render(<PairPhonePanel />);

    expect(await screen.findByText(/Sharing is off/)).toHaveTextContent('Allow other devices on this network');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
  });

  it('brackets an IPv6 address so the printed URL is one a browser accepts', async () => {
    instance.mockResolvedValue({ ...SHARED, addresses: ['10.0.0.5', '2001:db8::42'] });
    render(<PairPhonePanel />);
    await screen.findByRole('img', { name: /QR code/ });
    expect(screen.getByText('http://[2001:db8::42]:8080/')).toBeInTheDocument();
  });
});
