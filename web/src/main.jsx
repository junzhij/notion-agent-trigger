import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import App from './App.jsx';
import './styles.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const root = createRoot(document.getElementById('root'));

if (!publishableKey || !import.meta.env.VITE_ADMIN_API_URL) {
  root.render(
    <main className="container">
      <h1>配置缺失</h1>
      <p>请设置环境变量 VITE_CLERK_PUBLISHABLE_KEY 和 VITE_ADMIN_API_URL（见 web/.env.example）。</p>
    </main>,
  );
} else {
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={publishableKey}>
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
}
