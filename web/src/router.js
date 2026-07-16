import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/print/shipment/:id', component: () => import('./views/ShipPrint.vue') },
  { path: '/print/outsourcing/:id', component: () => import('./views/OutsourcingPrint.vue') },
  { path: '/print/outsourcing/:id/po', component: () => import('./views/OutsourcingPO.vue') },
  {
    path: '/',
    component: () => import('./views/Layout.vue'),
    children: [
      { path: '', component: () => import('./views/Dashboard.vue') },
      { path: 'orders', component: () => import('./views/Orders.vue') },
      { path: 'pieces', component: () => import('./views/Pieces.vue') },
      { path: 'orders/new', component: () => import('./views/OrderEdit.vue') },
      { path: 'orders/:id', component: () => import('./views/OrderDetail.vue') },
      { path: 'orders/:id/edit', component: () => import('./views/OrderEdit.vue') },
      { path: 'outsourcing', component: () => import('./views/Outsourcing.vue') },
      { path: 'shipments', component: () => import('./views/Shipments.vue') },
      { path: 'receivables', component: () => import('./views/Receivables.vue') },
      { path: 'vehicles', component: () => import('./views/Vehicles.vue') },
      { path: 'basics', component: () => import('./views/Basics.vue') },
      { path: 'users', component: () => import('./views/Users.vue') }
    ]
  }
];

const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes });

router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (!token && to.path !== '/login') return '/login';
  // 财务账号只在财务板块活动（服务端同样403强制）
  let role = null;
  try { role = JSON.parse(localStorage.getItem('user') || 'null')?.role; } catch {}
  if (token && role === 'finance' && !['/receivables', '/vehicles', '/login'].includes(to.path)) {
    return '/receivables';
  }
  if (token && to.path === '/login') return role === 'finance' ? '/receivables' : '/';
});

export default router;
