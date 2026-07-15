import axios from 'axios';
import { ElMessage } from 'element-plus';
import router from './router.js';

// BASE_URL 由 vite base 决定（/erp/），API 与静态资源同前缀，网关与3000直连通用
export const API_BASE = import.meta.env.BASE_URL + 'api';
export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

api.interceptors.response.use(
  r => r,
  err => {
    const msg = err.response?.data?.error || '网络错误，请检查服务器';
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (router.currentRoute.value.path !== '/login') router.push('/login');
    }
    ElMessage.error(msg);
    return Promise.reject(err);
  }
);

export function getUser() {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}

export function canSeePrice() {
  const u = getUser();
  return !!u && ['admin', 'procurement', 'finance', 'cnc_manager'].includes(u.role);
}

export function canEntry() {
  const u = getUser();
  return !!u && ['admin', 'procurement', 'cnc_manager', 'clerk', 'follower'].includes(u.role);
}

export function token() {
  return localStorage.getItem('token') || '';
}
