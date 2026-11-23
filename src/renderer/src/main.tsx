import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/index.css';

// Pre-paint theme: avoids light/dark flash on reload. Inlined here (rather
// than in index.html as a <script>) so the CSP can drop `script-src
// 'unsafe-inline'`. Runs synchronously before React mounts.
try {
  const t = localStorage.getItem('theme');
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
} catch {
  document.documentElement.setAttribute('data-theme', 'dark');
}

// Q0582: without GPU compositing, backdrop blur + endless animations keep both CPU cores busy and
// starve the main process (an SSH handshake then misses its 12 s deadline). Checked at start and
// again later, since Chromium can fall back to software after the GPU process starts.
const applyLowGraphics = () =>
  window.api.system
    .lowGraphics()
    .then((low) => document.documentElement.classList.toggle('low-graphics', low))
    .catch((err: unknown) => console.warn('low-graphics check failed', err));
void applyLowGraphics();
setTimeout(() => void applyLowGraphics(), 10_000);

window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledrejection]', e.reason);
});
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[window.error]', e.error ?? e.message);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
