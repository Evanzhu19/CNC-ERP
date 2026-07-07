<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-button type="primary" @click="openUser()">+ 新增用户</el-button>
      <span style="color: #909399; font-size: 13px; margin-left: 10px">
        只有 总经理 / 财务 / CNC主管 能看到单价和金额；其他角色完全看不到价格。
      </span>
    </div>
    <el-table :data="users">
      <el-table-column prop="username" label="用户名" width="140" />
      <el-table-column prop="name" label="姓名" width="140" />
      <el-table-column label="角色" width="130">
        <template #default="{ row }">
          <el-tag :type="priceRoles.includes(row.role) ? 'danger' : 'info'" size="small">{{ ROLE_NAMES[row.role] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="可见价格" width="90" align="center">
        <template #default="{ row }">{{ priceRoles.includes(row.role) ? '✓' : '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '正常' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="创建时间" width="170" />
      <el-table-column width="80">
        <template #default="{ row }"><el-button text type="primary" @click="openUser(row)">编辑</el-button></template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog" :title="form.id ? '编辑用户' : '新增用户'" width="440px">
    <el-form label-width="90px">
      <el-form-item label="用户名" required>
        <el-input v-model="form.username" :disabled="!!form.id" placeholder="登录用的账号" />
      </el-form-item>
      <el-form-item label="姓名" required><el-input v-model="form.name" /></el-form-item>
      <el-form-item label="角色" required>
        <el-select v-model="form.role" style="width: 100%">
          <el-option v-for="(label, value) in ROLE_NAMES" :key="value" :label="label + (priceRoles.includes(value) ? '（可见价格）' : '')" :value="value" />
        </el-select>
      </el-form-item>
      <el-form-item :label="form.id ? '重置密码' : '密码'">
        <el-input v-model="form.password" type="password" show-password :placeholder="form.id ? '留空则不改密码' : '至少6位'" />
      </el-form-item>
      <el-form-item v-if="form.id" label="状态">
        <el-switch v-model="form.active" active-text="正常" inactive-text="停用" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import { ROLE_NAMES } from '../consts.js';

const users = ref([]);
const dialog = ref(false);
const form = ref({});
const priceRoles = ['admin', 'finance', 'cnc_manager'];

async function load() {
  const { data } = await api.get('/users');
  users.value = data.users;
}

function openUser(row) {
  form.value = row
    ? { id: row.id, username: row.username, name: row.name, role: row.role, active: !!row.active, password: '' }
    : { username: '', name: '', role: 'clerk', password: '' };
  dialog.value = true;
}

async function save() {
  if (!form.value.username?.trim()) return ElMessage.warning('用户名不能为空');
  if (!form.value.name?.trim()) return ElMessage.warning('姓名不能为空');
  if (!form.value.id && (!form.value.password || form.value.password.length < 6)) return ElMessage.warning('密码至少6位');
  if (form.value.id) {
    const body = { name: form.value.name, role: form.value.role, active: form.value.active };
    if (form.value.password) body.password = form.value.password;
    await api.put(`/users/${form.value.id}`, body);
  } else {
    await api.post('/users', form.value);
  }
  ElMessage.success('已保存');
  dialog.value = false;
  load();
}

onMounted(load);
</script>

<style scoped>
.toolbar { margin-bottom: 12px; display: flex; align-items: center; }
</style>
