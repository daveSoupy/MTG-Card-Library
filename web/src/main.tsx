import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Phase 31: the network-first shell cache (public/sw.js — read its header
// before touching it). Production only: Vite's dev server has no /assets/
// and a worker holding a dev index.html would only confuse a reload.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
