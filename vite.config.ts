import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync } from 'node:fs';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), { name: 'pdf-font-resources', closeBundle() {
    mkdirSync('dist/pdfjs', { recursive: true });
    for (const name of ['cmaps', 'standard_fonts']) cpSync(`node_modules/pdfjs-dist/${name}`, `dist/pdfjs/${name}`, { recursive: true });
  } }],
  optimizeDeps: {
    include: ['exceljs', 'docx', 'file-saver'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pdfjs-dist')) {
            return 'pdfjs-vendor';
          }
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'echarts-vendor';
          }
          if (id.includes('node_modules/exceljs') || id.includes('node_modules/docx') || id.includes('node_modules/file-saver')) {
            return 'office-vendor';
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/lucide-react')) {
            return 'react-vendor';
          }
        }
      }
    }
  }
});
