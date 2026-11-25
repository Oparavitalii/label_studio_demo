import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/index.css';
import App from './App.jsx';
import { seedDemoTemplates } from './demo/demoTemplates.js';

// Demo mode (npm run dev / npm run demo): example templates on first load.
if (import.meta.env.VITE_DEMO_MODE === '1') seedDemoTemplates();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
