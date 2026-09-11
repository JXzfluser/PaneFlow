import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.jsx';
import { useStore } from './store.js';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// dev-only automation/testing hook (same store the UI drives)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__pf = useStore;
}
