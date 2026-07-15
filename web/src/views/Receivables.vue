<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="q" placeholder="搜客户/事由/备注" style="width: 200px" clearable />
      <el-select v-model="filter" style="width: 130px">
        <el-option label="未收清的" value="owed" />
        <el-option label="催款中的" value="remind" />
        <el-option label="全部" value="all" />
      </el-select>
      <div style="flex: 1"></div>
      <el-tag v-if="!canEdit" type="info">总经理查看模式（仅财务可操作）</el-tag>
      <el-button v-if="canEdit" type="primary" @click="openForm(null)">+ 记一笔应收</el-button>
    </div>

    <div v-if="totals" class="summary">
      <div class="sum-item"><span>应收合计</span><b>{{ money(totals.amount) }}</b></div>
      <div class="sum-item"><span>已收合计</span><b style="color:#67c23a">{{ money(totals.received) }}</b></div>
      <div class="sum-item"><span>未收余额</span><b style="color:#f56c6c">{{ money(totals.balance) }}</b></div>
      <div class="sum-item"><span>催款中</span><b style="color:#e6a23c">{{ totals.remind_count }} 笔 / {{ money(totals.remind_balance) }}</b></div>
    </div>

    <el-table :data="filtered" v-loading="loading" :row-class-name="rowClass">
      <el-table-column label="催款" width="70" align="center">
        <template #default="{ row }">
          <el-tooltip v-if="canEdit" :content="row.remind ? '点击取消催款标记' : '点击标记为需要催款'">
            <span class="bell" :class="{ on: row.remind }" @click="toggleRemind(row)">{{ row.remind ? '🔔' : '🔕' }}</span>
          </el-tooltip>
          <span v-else class="bell" :class="{ on: row.remind }" style="cursor: default">{{ row.remind ? '🔔' : '🔕' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="customer" label="客户/单位" min-width="140" show-overflow-tooltip />
      <el-table-column prop="biz" label="业务" width="100">
        <template #default="{ row }">
          <el-tag v-if="row.biz" size="small" :type="row.biz.includes('钢') ? 'warning' : row.biz.includes('CNC') ? 'primary' : 'info'">{{ row.biz }}</el-tag>
          <span v-else style="color:#c0c4cc">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="事由" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.title || '—' }}</template>
      </el-table-column>
      <el-table-column label="应收" width="120" align="right">
        <template #default="{ row }">{{ money(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="已收" width="120" align="right">
        <template #default="{ row }"><span style="color:#67c23a">{{ money(row.received) }}</span></template>
      </el-table-column>
      <el-table-column label="未收" width="130" align="right">
        <template #default="{ row }">
          <el-tag v-if="row.balance <= 0.005" type="success" size="small">已收清</el-tag>
          <b v-else style="color:#f56c6c">{{ money(row.balance) }}</b>
        </template>
      </el-table-column>
      <el-table-column prop="entry_date" label="记账日期" width="105" />
      <el-table-column prop="due_date" label="约定收款" width="105">
        <template #default="{ row }">
          <span :style="{ color: row.due_date && row.due_date < todayStr && row.balance > 0.005 ? '#f56c6c' : '' }">{{ row.due_date || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.note || '—' }}</template>
      </el-table-column>
      <el-table-column v-if="canEdit" label="操作" width="150">
        <template #default="{ row }">
          <el-button v-if="row.balance > 0.005" text type="success" size="small" @click="receive(row)">收款</el-button>
          <el-button text type="primary" size="small" @click="openForm(row)">编辑</el-button>
          <el-button text type="danger" size="small" @click="del(row)">删</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !filtered.length" description="没有符合条件的记录" />
  </el-card>

  <el-dialog v-model="formDialog" :title="form.id ? '编辑应收' : '记一笔应收'" width="460px">
    <el-form label-width="90px">
      <el-form-item label="客户/单位" required>
        <el-input v-model="form.customer" placeholder="手工填写，不限于CNC客户" />
      </el-form-item>
      <el-form-item label="业务类型">
        <el-select v-model="form.biz" style="width: 100%" clearable filterable allow-create default-first-option placeholder="选一个或直接输入">
          <el-option v-for="b in ['CNC加工', '模具钢材', '其他']" :key="b" :label="b" :value="b" />
        </el-select>
      </el-form-item>
      <el-form-item label="事由">
        <el-input v-model="form.title" placeholder="如：6月份货款 / S50C钢料一批" />
      </el-form-item>
      <el-form-item label="应收金额" required>
        <el-input-number v-model="form.amount" :min="0.01" :precision="2" :controls="false" style="width: 100%" />
      </el-form-item>
      <el-form-item v-if="form.id" label="已收金额">
        <el-input-number v-model="form.received" :min="0" :precision="2" :controls="false" style="width: 100%" />
      </el-form-item>
      <el-form-item label="记账日期" required>
        <el-date-picker v-model="form.entry_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="约定收款">
        <el-date-picker v-model="form.due_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" placeholder="可不填" />
      </el-form-item>
      <el-form-item label="催款标记">
        <el-switch v-model="form.remind" active-text="需要催款" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.note" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="formDialog = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, getUser } from '../api.js';

// 只有财务能操作；总经理只读（服务端同样强制）
const canEdit = getUser()?.role === 'finance';
const rows = ref([]);
const totals = ref(null);
const loading = ref(false);
const q = ref('');
const filter = ref('owed');
const formDialog = ref(false);
const form = ref({});
const todayStr = new Date().toISOString().slice(0, 10);

const filtered = computed(() => {
  let r = rows.value;
  if (filter.value === 'owed') r = r.filter(x => x.balance > 0.005);
  if (filter.value === 'remind') r = r.filter(x => x.remind && x.balance > 0.005);
  const kw = q.value.trim();
  if (kw) r = r.filter(x => [x.customer, x.title, x.note, x.biz].some(v => v && v.includes(kw)));
  return r;
});

function money(v) {
  return '¥' + Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rowClass({ row }) {
  if (row.remind && row.balance > 0.005) return 'remind-row';
  return '';
}

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get('/finance/entries');
    rows.value = data.entries;
    totals.value = data.totals;
  } finally { loading.value = false; }
}

function openForm(row) {
  form.value = row
    ? { id: row.id, customer: row.customer, biz: row.biz, title: row.title, amount: row.amount, received: row.received, entry_date: row.entry_date, due_date: row.due_date, remind: !!row.remind, note: row.note }
    : { customer: '', biz: null, title: '', amount: null, entry_date: todayStr, due_date: null, remind: false, note: '' };
  formDialog.value = true;
}

async function save() {
  const f = form.value;
  if (!f.customer?.trim()) return ElMessage.warning('请填写客户/单位');
  if (!(f.amount > 0)) return ElMessage.warning('请填写应收金额');
  if (!f.entry_date) return ElMessage.warning('请选择记账日期');
  if (f.id) await api.put(`/finance/entries/${f.id}`, f);
  else await api.post('/finance/entries', f);
  ElMessage.success('已保存');
  formDialog.value = false;
  load();
}

async function receive(row) {
  const { value } = await ElMessageBox.prompt(
    `「${row.customer}」还欠 ${money(row.balance)}，本次收到多少？`,
    '登记收款',
    { inputValue: String(row.balance), inputPattern: /^\d+(\.\d{1,2})?$/, inputErrorMessage: '请输入金额', confirmButtonText: '登记' }
  );
  await api.post(`/finance/entries/${row.id}/receive`, { amount: Number(value) });
  ElMessage.success('收款已登记');
  load();
}

async function toggleRemind(row) {
  await api.post(`/finance/entries/${row.id}/remind`);
  load();
}

async function del(row) {
  await ElMessageBox.confirm(`删除「${row.customer}」这笔 ${money(row.amount)} 的应收记录？`, '确认删除', { type: 'warning' });
  await api.delete(`/finance/entries/${row.id}`);
  ElMessage.success('已删除');
  load();
}

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
.summary { display: flex; gap: 28px; padding: 10px 14px; background: #f5f7fa; border-radius: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.sum-item span { color: #909399; font-size: 13px; margin-right: 8px; }
.sum-item b { font-size: 16px; }
.bell { cursor: pointer; font-size: 16px; opacity: 0.35; }
.bell.on { opacity: 1; }
:deep(.remind-row) td { background: #fdf6e3 !important; }
</style>
