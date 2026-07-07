<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2 style="text-align:center; margin: 0 0 8px;">CNC加工 ERP</h2>
      <p style="text-align:center; color:#909399; margin: 0 0 24px;">订单与生产进度管理系统</p>
      <el-form @submit.prevent="doLogin">
        <el-form-item>
          <el-input v-model="username" placeholder="用户名" size="large" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="密码" size="large" show-password @keyup.enter="doLogin" />
        </el-form-item>
        <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="doLogin">登 录</el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';

const router = useRouter();
const username = ref('');
const password = ref('');
const loading = ref(false);

async function doLogin() {
  if (!username.value || !password.value) return ElMessage.warning('请输入用户名和密码');
  loading.value = true;
  try {
    const { data } = await api.post('/login', { username: username.value, password: password.value });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    router.push('/');
  } catch { /* interceptor 已提示 */ } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap { height: 100%; display: flex; align-items: center; justify-content: center; background: #1f2d3d; }
.login-card { width: 360px; padding: 12px; }
</style>
