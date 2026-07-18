import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the build works both at meet.hakonvidir.is and at the
// hakonharalds.github.io/meetpoint/ fallback URL.
export default defineConfig({
  base: './',
  plugins: [react()],
})
