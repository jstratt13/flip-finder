import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/flip-finder/',
  // Fixed port so this never silently drifts onto the DBP Tracker's 5173.
  server: { port: 5174, strictPort: true },
});
