<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-date-picker v-model="filters.month" type="month" placeholder="出货月份" format="YYYY-MM" value-format="YYYY-MM" style="width: 140px" @change="load" />
      <el-input v-model="filters.q" placeholder="送货单号 / 订单号 / 客户PO / 客户" style="width: 260px" clearable @keyup.enter="load" @clear="load" />
      <el-button @click="load">查询</el-button>
      <span style="color:#909399; font-size:13px; margin-left:8px">出货操作在订单详情里做；这里集中查看和打印所有送货单</span>
    </div>

    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="ship_no" label="送货单号" width="120" />
      <el-table-column prop="ship_date" label="送货日期" width="115" />
      <el-table-column prop="customer_name" label="客户" min-width="140" show-overflow-tooltip />
      <el-table-column prop="customer_po" label="客户PO" width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.customer_po || '—' }}</template>
      </el-table-column>
      <el-table-column label="订单号" width="110">
        <template #default="{ row }">
          <a href="javascript:;" style="color:#409eff; text-decoration:none" @click="$router.push(`/orders/${row.order_id}`)">{{ row.order_no }}</a>
        </template>
      </el-table-column>
      <el-table-column prop="piece_count" label="件数" width="70" align="center" />
      <el-table-column v-if="showPrice" label="金额" width="120" align="right">
        <template #default="{ row }">{{ fmtMoney(row.amount) }}</template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.note || '—' }}</template>
      </el-table-column>
      <el-table-column prop="created_by_name" label="经手人" width="90" />
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button text type="primary" size="small" @click="print(row.id)">打印</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !rows.length" description="还没有送货单" />
  </el-card>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, canSeePrice } from '../api.js';

const router = useRouter();
const rows = ref([]);
const loading = ref(false);
const filters = ref({ month: null, q: '' });
const showPrice = canSeePrice();

function fmtMoney(v) {
  if (v == null) return '—';
  return '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function load() {
  loading.value = true;
  try {
    const params = {};
    if (filters.value.month) params.month = filters.value.month;
    if (filters.value.q) params.q = filters.value.q;
    const { data } = await api.get('/shipments', { params });
    rows.value = data.shipments;
  } finally { loading.value = false; }
}

function print(id) {
  window.open(router.resolve(`/print/shipment/${id}`).href, '_blank');
}

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
</style>
