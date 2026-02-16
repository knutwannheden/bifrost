import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './context/AppContext';
import App from './App';
import './index.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <AppProvider>
    <App />
  </AppProvider>,
);
