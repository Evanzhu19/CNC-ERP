<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="q" placeholder="搜客户名" style="width: 200px" clearable />
      <el-checkbox v-model="onlyOwed" label="只看有欠款的" style="margin-left: 4px" />
      <div style="flex: 1"></div>
      <div v-if="totals" class="totals">
        累计出货 <b>{{ money(totals.shipped) }}</b>　已回款 <b style="color:#67c23a">{{ money(totals.paid) }}</b>
        欠款合计 <b style="color:#f56c6c">{{ money(totals.balance) }}</b>
      </div>
    </div>

    <el-table :data="filtered" v-loading="loading" @row-click="openDetail" style="cursor: pointer">
      <el-table-column prop="customer_name" label="客户" min-width="160" show-overflow-tooltip />
      <el-table-column label="已出货金额" width="130" align="right">
        <template #default="{ row }">
          {{ money(row.shipped_amount) }}
          <el-tooltip v-if="row.unpriced_pieces" :content="`有 ${row.unpriced_pieces} 件已出货的板没填单价，没算进金额`">
            <el-tag type="warning" size="small" style="margin-left:4px">缺价{{ row.unpriced_pieces }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="已回款" width="120" align="right">
        <template #default="{ row }"><span style="color:#67c23a">{{ money(row.paid_amount) }}</span></template>
      </el-table-column>
      <el-table-column label="欠款余额" width="130" align="right">
        <template #default="{ row }">
          <b :style="{ color: row.balance > 0 ? '#f56c6c' : '#67c23a' }">{{ money(row.balance) }}</b>
        </template>
      </el-table-column>
      <el-table-column prop="shipped_pieces" label="出货件数" width="90" align="center" />
      <el-table-column prop="last_ship_date" label="最近出货" width="110">
        <template #default="{ row }">{{ row.last_ship_date || '—' }}</template>
      </el-table-column>
      <el-table-column prop="last_pay_date" label="最近回款" width="110">
        <template #default="{ row }">{{ row.last_pay_date || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110">
        <template #default="{ row }">
          <el-button v-if="canPay" text type="primary" size="small" @click.stop="openPay(row)">登记回款</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !filtered.length" description="还没有出货或回款记录" />
  </el-card>

  <el-dialog v-model="detailDialog" :title="`应收明细 — ${detail?.customer.name || ''}`" width="860px" top="5vh">
    <div v-if="detail">
      <h4 style="margin: 0 0 8px">出货订单（应收依据：已出货件 × 单价）</h4>
      <el-table :data="detail.orders" size="small" border max-height="300">
        <el-table-column prop="order_no" label="订单号" width="100">
          <template #default="{ row }">
            <a href="javascript:;" style="color:#409eff; text-decoration:none" @click="$router.push(`/orders/${row.order_id}`)">{{ row.order_no }}</a>
          </template>
        </el-table-column>
        <el-table-column prop="customer_po" label="客户PO" width="130" show-overflow-tooltip />
        <el-table-column prop="shipped_pieces" label="已出件数" width="90" align="center" />
        <el-table-column label="出货金额" width="120" align="right">
          <template #default="{ row }">
            {{ money(row.shipped_amount) }}
            <el-tag v-if="row.unpriced_pieces" type="warning" size="small">缺价{{ row.unpriced_pieces }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="first_ship" label="首次出货" width="105" />
        <el-table-column prop="last_ship" label="最近出货" width="105" />
        <el-table-column prop="status" label="状态" width="80">
          <template #default="{ row }">{{ row.status === 'closed' ? '已结案' : '进行中' }}</template>
        </el-table-column>
      </el-table>

      <h4 style="margin: 16px 0 8px">回款记录</h4>
      <el-table :data="detail.payments" size="small" border max-height="240">
        <el-table-column prop="pay_date" label="日期" width="110" />
        <el-table-column label="金额" width="130" align="right">
          <template #default="{ row }"><b style="color:#67c23a">{{ money(row.amount) }}</b></template>
        </el-table-column>
        <el-table-column prop="method" label="方式" width="100">
          <template #default="{ row }">{{ row.method || '—' }}</template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="150" show-overflow-tooltip />
        <el-table-column prop="created_by_name" label="经手人" width="90" />
        <el-table-column v-if="canPay" label="" width="60">
          <template #default="{ row }">
            <el-button text type="danger" size="small" @click="delPayment(row)">删</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!detail.payments.length" description="还没有回款记录" :image-size="40" />
    </div>
    <template #footer>
      <el-button v-if="canPay && detail" type="primary" @click="openPay({ customer_id: detail.customer.id, customer_name: detail.customer.name })">登记回款</el-button>
      <el-button @click="detailDialog = false">关闭</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="payDialog" :title="`登记回款 — ${payForm.customer_name}`" width="420px">
    <el-form label-width="80px">
      <el-form-item label="金额" required>
        <el-input-number v-model="payForm.amount" :min="0.01" :precision="2" :controls="false" style="width: 100%" placeholder="实际到账金额" />
      </el-form-item>
      <el-form-item label="日期" required>
        <el-date-picker v-model="payForm.pay_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="方式">
        <el-select v-model="payForm.method" style="width: 100%" clearable placeholder="可不选">
          <el-option v-for="m in ['转账', '承兑汇票', '现金', '其他']" :key="m" :label="m" :value="m" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="payForm.note" placeholder="如：6月份货款" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="payDialog = false">取消</el-button>
      <el-button type="primary" @click="submitPay">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, getUser } from '../api.js';

const rows = ref([]);
const totals = ref(null);
const loading = ref(false);
const q = ref('');
const onlyOwed = ref(true);
const canPay = ['admin', 'procurement', 'finance'].includes(getUser()?.role);

const detailDialog = ref(false);
const detail = ref(null);
const payDialog = ref(false);
const payForm = ref({});

const filtered = computed(() => {
  let r = rows.value;
  if (onlyOwed.value) r = r.filter(x => x.balance > 0.005);
  const kw = q.value.trim();
  if (kw) r = r.filter(x => x.customer_name.includes(kw));
  return r;
});

function money(v) {
  return '¥' + Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get('/receivables');
    rows.value = data.receivables;
    totals.value = data.totals;
  } finally { loading.value = false; }
}

async function openDetail(row) {
  const { data } = await api.get(`/receivables/${row.customer_id}`);
  detail.value = data;
  detailDialog.value = true;
}

function openPay(row) {
  payForm.value = {
    customer_id: row.customer_id, customer_name: row.customer_name,
    amount: null, pay_date: new Date().toISOString().slice(0, 10), method: '转账', note: ''
  };
  payDialog.value = true;
}

async function submitPay() {
  const f = payForm.value;
  if (!(f.amount > 0)) return ElMessage.warning('请填写回款金额');
  if (!f.pay_date) return ElMessage.warning('请选择回款日期');
  await api.post('/payments', f);
  ElMessage.success('回款已登记');
  payDialog.value = false;
  await load();
  if (detailDialog.value && detail.value) {
    const { data } = await api.get(`/receivables/${detail.value.customer.id}`);
    detail.value = data;
  }
}

async function delPayment(row) {
  await ElMessageBox.confirm(`删除这笔 ${money(row.amount)}（${row.pay_date}）的回款记录？`, '确认删除', { type: 'warning' });
  await api.delete(`/payments/${row.id}`);
  ElMessage.success('已删除');
  await load();
  const { data } = await api.get(`/receivables/${detail.value.customer.id}`);
  detail.value = data;
}

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
.totals { color: #606266; font-size: 14px; }
</style>
