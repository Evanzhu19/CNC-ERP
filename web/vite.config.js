import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // 统一门户：ERP 挂在 /erp/ 子路径下（80端口网关反代，3000直连两者都支持）
  base: '/erp/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/erp/api': 'http://localhost:3000' }
  }
});
