import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider } from './contexts/LanguageContext';
import './index.css';

// Register the service worker so the app is installable and push notifications
// work even when the window is minimised or the tab is closed.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <LanguageProvider>
          <AuthProvider>
            <SocketProvider>
            <App />
            <Toaster
            position="top-center"
            toastOptions={{
              style: {
                fontFamily: 'Nunito, sans-serif',
                fontWeight: 600,
                borderRadius: '12px',
              },
              success: {
                style: { background: '#7c3aed', color: '#fff' },
                iconTheme: { primary: '#fff', secondary: '#7c3aed' },
              },
              error: {
                style: { background: '#ef4444', color: '#fff' },
                iconTheme: { primary: '#fff', secondary: '#ef4444' },
              },
            }}
          />
            </SocketProvider>
          </AuthProvider>
        </LanguageProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
