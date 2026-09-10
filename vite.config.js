import { defineConfig } from 'vite';

// Minimal config. Run with `npm run dev` and open http://localhost:5173.
// A secure context (localhost or https) is required for getUserMedia.
export default defineConfig({
  server: {
    host: 'localhost',
    port: 5173,
  },
});
