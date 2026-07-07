import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/print/shipment/:id', component: () => import('./views/ShipPrint.vue') },
  { path: '/print/outsourcing/:id', component: () => import('./views/OutsourcingPrint.vue') },
  {
    path: '/',
    component: () => import('./views/Layout.vue'),
    children: [
      { path: '', component: () => import('./views/Dashboard.vue') },
      { path: 'orders', component: () => import('./views/Orders.vue') },
      { path: 'orders/new', component: () => import('./views/OrderEdit.vue') },
      { path: 'orders/:id', component: () => import('./views/OrderDetail.vue') },
      { path: 'orders/:id/edit', component: () => import('./views/OrderEdit.vue') },
      { path: 'outsourcing', component: () => import('./views/Outsourcing.vue') },
      { path: 'basics', component: () => import('./views/Basics.vue') },
      { path: 'users', component: () => import('./views/Users.vue') }
    ]
  }
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (!token && to.path !== '/login') return '/login';
  if (token && to.path === '/login') return '/';
});

export default router;
