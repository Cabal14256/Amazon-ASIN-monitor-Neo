import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AuthProvider } from './auth/provider';
import './index.css';
import { createAppRouter } from './router';
import { identity, transport } from './services/browser-runtime';

const router = createAppRouter(identity);

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点');
}

const root = createRoot(container);
root.render(
  <StrictMode>
    <QueryClientProvider client={transport.queryClient}>
      <AuthProvider identity={identity} runtime={transport}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);

if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
