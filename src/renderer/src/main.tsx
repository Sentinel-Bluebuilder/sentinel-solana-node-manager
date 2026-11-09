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
