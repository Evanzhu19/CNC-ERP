<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="q" placeholder="搜板件号/图号/规格/材质/品名/客户/订单号" style="width: 340px"
        clearable @keyup.enter="load" @clear="load">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="stage" placeholder="全部工序阶段" clearable style="width: 150px" @change="load">
        <el-option label="待铣磨" value="wait_milling" />
        <el-option label="待CNC" value="wait_cnc" />
        <el-option label="待精磨" value="wait_grinding" />
        <el-option label="待电镀" value="wait_plating" />
        <el-option label="待出货" value="plating_done" />
        <el-option label="外发中" value="out" />
        <el-option label="已出货" value="shipped" />
      </el-select>
      <el-select v-model="orderStatus" style="width: 130px" @change="load">
        <el-option label="进行中订单" value="active" />
        <el-option label="已结案" value="closed" />
        <el-option label="全部订单" value="" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <div style="flex:1"></div>
      <span style="color:#909399; font-size:13px">共 {{ pieces.length }} 块板{{ pieces.length >= 300 ? '（最多显示300块，请缩小范围）' : '' }}</span>
    </div>

    <el-table :data="pieces" v-loading="loading" size="small" :row-class-name="rowClass"
      @row-click="r => $router.push(`/orders/${r.order_id}`)" style="cursor:pointer">
      <el-table-column prop="piece_code" label="板件号" width="130" fixed />
      <el-table-column prop="part_no" label="编号" width="90" show-overflow-tooltip />
      <el-table-column prop="drawing_no" label="图号" width="120" show-overflow-tooltip />
      <el-table-column prop="item_name" label="品名" width="105" show-overflow-tooltip />
      <el-table-column prop="spec" label="规格" width="125" show-overflow-tooltip />
      <el-table-column prop="material" label="材质" width="66" show-overflow-tooltip />
      <el-table-column prop="customer_name" label="客户" width="110" show-overflow-tooltip />
      <el-table-column label="客户PO" width="140" show-overflow-tooltip>
        <template #default="{ row }"><b>{{ row.customer_po || '—' }}</b></template>
      </el-table-column>
      <el-table-column prop="order_no" label="订单号" width="96" />
      <el-table-column label="当前状态" min-width="160">
        <template #default="{ row }">
          <el-tag v-if="row.status_type === 'special'" size="small" class="tag-special">{{ row.status_label }}</el-tag>
          <el-tag v-else-if="row.status_type === 'wip'" type="primary" size="small" effect="dark">{{ row.status_label }}</el-tag>
          <el-tag v-else :type="row.status_type" size="small">{{ row.status_label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="滞留" width="72" align="center">
        <template #default="{ row }">
          <span v-if="row.status_label === '已出货'" class="muted">—</span>
          <b v-else-if="row.stall_level === 'alert'" style="color:#f56c6c">{{ row.idle_days }}天</b>
          <b v-else-if="row.stall_level === 'warn'" style="color:#e6a23c">{{ row.idle_days }}天</b>
          <span v-else class="muted">{{ row.idle_days }}天</span>
        </template>
      </el-table-column>
      <el-table-column prop="due_date" label="交期" width="105">
        <template #default="{ row }">
          <span :style="{ color: row.order_status === 'active' && row.due_date && row.due_date < today ? '#f56c6c' : '' }">{{ row.due_date || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="件备注" min-width="120" show-overflow-tooltip />
    </el-table>
    <el-empty v-if="!loading && !pieces.length" :description="q || stage ? '没有符合条件的板件' : '输入关键词查询，或直接筛选工序阶段'" />
  </el-card>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { api } from '../api.js';

const q = ref('');
const stage = ref('');
const orderStatus = ref('active');
const pieces = ref([]);
const loading = ref(false);
const today = new Date().toISOString().slice(0, 10);

function rowClass({ row }) {
  if (row.status_label === '已出货') return '';
  if (row.stall_level === 'alert') return 'stall-alert';
  if (row.stall_level === 'warn') return 'stall-warn';
  return '';
}

async function load() {
  loading.value = true;
  try {
    const params = {};
    if (q.value.trim()) params.q = q.value.trim();
    if (stage.value) params.stage = stage.value;
    if (orderStatus.value) params.status = orderStatus.value;
    const { data } = await api.get('/pieces/search', { params });
    pieces.value = data.pieces;
  } finally { loading.value = false; }
}

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
.muted { color: #909399; }
.tag-special { background: #f3eefc !important; border-color: #b39ddb !important; color: #6a3fb5 !important; }
:deep(.stall-warn) td { background: #fdf6e3 !important; }
:deep(.stall-alert) td { background: #fdeaea !important; }
</style>
