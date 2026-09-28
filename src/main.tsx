import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

declare const __BUILD_ID__: string;

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js?v=${encodeURIComponent(__BUILD_ID__)}`).then((registration) => {
      const showUpdate = () => window.dispatchEvent(new Event('pwa-update-ready'));
      if (registration.waiting && hadController) showUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && hadController) showUpdate(); });
      });
    }).catch(() => undefined);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; window.location.reload(); }
    });
  });
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
