import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Global Fetch Interceptor to rewrite hardcoded local API base URLs in production/hosting
const API_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const originalFetch = window.fetch;
window.fetch = function (input, init) {
  if (typeof input === 'string' && input.startsWith('http://127.0.0.1:8000')) {
    input = input.replace('http://127.0.0.1:8000', API_URL);
  } else if (typeof input === 'string' && input.startsWith('http://localhost:8000')) {
    input = input.replace('http://localhost:8000', API_URL);
  }
  return originalFetch(input, init);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
