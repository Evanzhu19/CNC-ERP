<template>
  <el-card shadow="never">
    <div class="toolbar">
      <span style="color:#909399; font-size:13px">年检或商业保险到期前 30 天黄色提醒、过期红色报警，看板首页同步显示</span>
      <div style="flex: 1"></div>
      <el-button v-if="editable" type="primary" @click="openForm(null)">+ 添加车辆</el-button>
    </div>

    <el-table :data="vehicles" v-loading="loading" :row-class-name="rowClass">
      <el-table-column prop="plate_no" label="车牌" width="130">
        <template #default="{ row }"><b>{{ row.plate_no }}</b></template>
      </el-table-column>
      <el-table-column prop="name" label="车辆" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.name || '—' }}</template>
      </el-table-column>
      <el-table-column label="年检到期" width="200">
        <template #default="{ row }"><due-cell :due="row.inspection" /></template>
      </el-table-column>
      <el-table-column label="商业保险到期" width="200">
        <template #default="{ row }"><due-cell :due="row.insurance" /></template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.note || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '在用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="editable" label="操作" width="110">
        <template #default="{ row }">
          <el-button text type="primary" size="small" @click="openForm(row)">编辑</el-button>
          <el-button v-if="canDelete" text type="danger" size="small" @click="del(row)">删</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !vehicles.length" description="还没有登记车辆" />
  </el-card>

  <el-dialog v-model="formDialog" :title="form.id ? '编辑车辆' : '添加车辆'" width="440px">
    <el-form label-width="100px">
      <el-form-item label="车牌号" required><el-input v-model="form.plate_no" placeholder="如 粤S·A1234" /></el-form-item>
      <el-form-item label="车辆"><el-input v-model="form.name" placeholder="如 五菱货车 / 老板的SUV" /></el-form-item>
      <el-form-item label="年检到期日">
        <el-date-picker v-model="form.inspection_due" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="商业保险到期">
        <el-date-picker v-model="form.insurance_due" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="form.note" /></el-form-item>
      <el-form-item v-if="form.id" label="状态">
        <el-switch v-model="form.active" active-text="在用" inactive-text="停用" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="formDialog = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, h, onMounted } from 'vue';
import { ElMessage, ElMessageBox, ElTag } from 'element-plus';
import { api, canEntry, getUser } from '../api.js';

const DueCell = {
  props: ['due'],
  render() {
    const d = this.due;
    if (!d) return h('span', { style: 'color:#c0c4cc' }, '未填');
    const parts = [h('span', d.date)];
    if (d.level === 'overdue') {
      parts.push(h(ElTag, { type: 'danger', size: 'small', style: 'margin-left:6px' }, () => `已过期 ${-d.days_left} 天`));
    } else if (d.level === 'warn') {
      parts.push(h(ElTag, { type: 'warning', size: 'small', style: 'margin-left:6px' }, () => `${d.days_left} 天后到期`));
    }
    return h('span', parts);
  }
};

const vehicles = ref([]);
const loading = ref(false);
const editable = canEntry();
const canDelete = ['admin', 'procurement', 'finance'].includes(getUser()?.role);
const formDialog = ref(false);
const form = ref({});

function rowClass({ row }) {
  const lv = [row.inspection?.level, row.insurance?.level];
  if (lv.includes('overdue')) return 'stall-alert';
  if (lv.includes('warn')) return 'stall-warn';
  return '';
}

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get('/vehicles');
    vehicles.value = data.vehicles;
  } finally { loading.value = false; }
}

function openForm(row) {
  form.value = row
    ? { id: row.id, plate_no: row.plate_no, name: row.name, inspection_due: row.inspection_due, insurance_due: row.insurance_due, note: row.note, active: !!row.active }
    : { plate_no: '', name: '', inspection_due: null, insurance_due: null, note: '' };
  formDialog.value = true;
}

async function save() {
  if (!form.value.plate_no?.trim()) return ElMessage.warning('请填写车牌号');
  if (form.value.id) await api.put(`/vehicles/${form.value.id}`, form.value);
  else await api.post('/vehicles', form.value);
  ElMessage.success('已保存');
  formDialog.value = false;
  load();
}

async function del(row) {
  await ElMessageBox.confirm(`删除车辆 ${row.plate_no}？`, '确认删除', { type: 'warning' });
  await api.delete(`/vehicles/${row.id}`);
  ElMessage.success('已删除');
  load();
}

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
:deep(.stall-warn) td { background: #fdf6e3 !important; }
:deep(.stall-alert) td { background: #fdeaea !important; }
</style>
