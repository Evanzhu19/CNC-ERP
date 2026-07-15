<template>
  <el-container style="height: 100%;">
    <el-aside width="200px" class="aside">
      <div class="logo">CNC ERP</div>
      <el-menu :default-active="activeMenu" router background-color="#1f2d3d" text-color="#cfd6dd" active-text-color="#409eff">
        <el-menu-item index="/"><el-icon><Odometer /></el-icon>看板</el-menu-item>
        <el-menu-item index="/orders"><el-icon><Document /></el-icon>订单管理</el-menu-item>
        <el-menu-item index="/pieces"><el-icon><Search /></el-icon>板件查询</el-menu-item>
        <el-menu-item index="/outsourcing"><el-icon><Van /></el-icon>外发管理</el-menu-item>
        <el-menu-item index="/shipments"><el-icon><Tickets /></el-icon>送货单</el-menu-item>
        <el-menu-item v-if="canFinance" index="/receivables"><el-icon><Money /></el-icon>应收账款</el-menu-item>
        <el-menu-item index="/vehicles"><el-icon><AlarmClock /></el-icon>车辆提醒</el-menu-item>
        <el-menu-item index="/basics"><el-icon><OfficeBuilding /></el-icon>客户与厂家</el-menu-item>
        <el-menu-item v-if="['admin', 'procurement'].includes(user?.role)" index="/users"><el-icon><User /></el-icon>用户管理</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span></span>
        <el-dropdown @command="onCommand">
          <span class="user-chip">{{ user?.name }}（{{ roleName }}）<el-icon><ArrowDown /></el-icon></span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="pwd">修改密码</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>
      <el-main style="padding: 16px;">
        <router-view />
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="pwdDialog" title="修改密码" width="400px">
    <el-form label-width="80px">
      <el-form-item label="原密码"><el-input v-model="pwd.old_password" type="password" show-password /></el-form-item>
      <el-form-item label="新密码"><el-input v-model="pwd.new_password" type="password" show-password /></el-form-item>
      <el-form-item label="再输一次"><el-input v-model="pwd.confirm" type="password" show-password /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="pwdDialog = false">取消</el-button>
      <el-button type="primary" @click="changePwd">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Odometer, Document, Van, OfficeBuilding, User, ArrowDown, Search, Tickets, Money, AlarmClock } from '@element-plus/icons-vue';
import { api, getUser } from '../api.js';
import { ROLE_NAMES } from '../consts.js';

const route = useRoute();
const router = useRouter();
const user = getUser();
// 应收账款仅 财务(可操作) 和 总经理(只读) 可见，其余角色（含采购主管）完全不可见
const canFinance = ['admin', 'finance'].includes(user?.role);
const roleName = computed(() => ROLE_NAMES[user?.role] || user?.role);
const activeMenu = computed(() => {
  if (route.path.startsWith('/orders')) return '/orders';
  if (route.path.startsWith('/pieces')) return '/pieces';
  if (route.path.startsWith('/outsourcing')) return '/outsourcing';
  if (route.path.startsWith('/shipments')) return '/shipments';
  return route.path;
});

const pwdDialog = ref(false);
const pwd = ref({ old_password: '', new_password: '', confirm: '' });

async function onCommand(cmd) {
  if (cmd === 'logout') {
    try { await api.post('/logout'); } catch {}
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    router.push('/login');
  } else if (cmd === 'pwd') {
    pwd.value = { old_password: '', new_password: '', confirm: '' };
    pwdDialog.value = true;
  }
}

async function changePwd() {
  if (pwd.value.new_password !== pwd.value.confirm) return ElMessage.warning('两次输入的新密码不一致');
  await api.post('/me/password', pwd.value);
  ElMessage.success('密码已修改');
  pwdDialog.value = false;
}
</script>

<style scoped>
.aside { background: #1f2d3d; }
.logo { color: #fff; font-size: 18px; font-weight: bold; padding: 18px 20px; }
.aside :deep(.el-menu) { border-right: none; }
.header { background: #fff; border-bottom: 1px solid #e4e7ed; display: flex; align-items: center; justify-content: space-between; }
.user-chip { cursor: pointer; color: #303133; display: inline-flex; align-items: center; gap: 4px; }
</style>
