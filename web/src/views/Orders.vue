<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-select v-model="filters.status" style="width: 120px" @change="load">
        <el-option label="进行中" value="active" />
        <el-option label="已结案" value="closed" />
        <el-option label="已作废" value="void" />
        <el-option label="全部" value="" />
      </el-select>
      <el-select v-model="filters.customer_id" placeholder="全部客户" clearable filterable style="width: 180px" @change="load">
        <el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-date-picker v-model="filters.month" type="month" placeholder="下单月份" format="YYYY-MM" value-format="YYYY-MM" style="width: 140px" @change="load" />
      <el-input v-model="filters.q" placeholder="订单号/客户PO/编号/图号/规格/品名/板件号" style="width: 280px" clearable @keyup.enter="load" @clear="load" />
      <el-button @click="load">查询</el-button>
      <div style="flex: 1"></div>
      <el-button v-if="entry" type="warning" plain @click="openReconcile">PDF+台账 双证录入</el-button>
      <el-button v-if="entry" type="success" plain @click="openExcelImport">Excel批量导入</el-button>
      <el-button v-if="entry" type="primary" @click="$router.push('/orders/new')">+ 新建订单</el-button>
    </div>

    <el-table :data="orders" v-loading="loading" @row-click="r => $router.push(`/orders/${r.id}`)" style="cursor: pointer">
      <el-table-column prop="order_no" label="订单号" width="110" />
      <el-table-column prop="customer_name" label="客户" min-width="140" show-overflow-tooltip />
      <el-table-column prop="customer_po" label="客户PO" width="130" show-overflow-tooltip />
      <el-table-column prop="order_date" label="下单日" width="105" />
      <el-table-column prop="due_date" label="交期" width="105">
        <template #default="{ row }">
          <span :style="{ color: row.status === 'active' && row.due_date && row.due_date < today ? '#f56c6c' : '' }">{{ row.due_date || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="进度（件）" min-width="220">
        <template #default="{ row }">
          <span class="prog">铣{{ row.milling || 0 }} · C{{ row.cnc || 0 }} · 磨{{ row.grinding || 0 }} · 镀回{{ row.plating_back || 0 }} · 出{{ row.shipped || 0 }} / {{ row.total || 0 }}</span>
          <el-tag v-if="row.wip_now" type="primary" size="small" style="margin-left: 6px">加工中{{ row.wip_now }}件</el-tag>
          <el-tag v-if="row.out_now" type="warning" size="small" style="margin-left: 4px">在外{{ row.out_now }}件</el-tag>
          <el-tag v-if="row.flagged_now" size="small" class="tag-special" style="margin-left: 4px">特殊{{ row.flagged_now }}件</el-tag>
          <el-tag v-if="row.status === 'active' && row.stall_alert_count" type="danger" size="small" effect="dark" style="margin-left: 4px">滞留{{ row.stall_alert_count }}件</el-tag>
          <el-tag v-else-if="row.status === 'active' && row.stall_warn_count" type="warning" size="small" effect="dark" style="margin-left: 4px">滞留{{ row.stall_warn_count }}件</el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="showPrice" label="金额" width="120" align="right">
        <template #default="{ row }">
          <span>{{ fmtMoney(row.amount) }}</span>
          <el-tooltip v-if="row.unpriced_lines" content="有明细行还没填单价"><span style="color:#e6a23c"> *</span></el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="ORDER_STATUS[row.status].type" size="small">{{ ORDER_STATUS[row.status].label }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !orders.length" description="没有符合条件的订单" />
  </el-card>

  <el-dialog v-model="reconcileDialog" title="PDF+台账 双证录入" width="720px" top="6vh">
    <el-alert type="info" :closable="false" style="margin-bottom: 14px"
      title="同时上传：客户的PDF采购单 + Excel台账。系统按PO号在台账里找到对应订单，核对 PO/客户/总件数/总金额，全部对上才准录入。件数或金额对不上（比如台账少录了）会拦下来。" />
    <div style="display:flex; gap:16px; margin-bottom:14px;">
      <div style="flex:1">
        <div style="margin-bottom:6px; color:#606266">① 客户PDF采购单</div>
        <input ref="pdfInput" type="file" accept=".pdf" style="display:none" @change="e => pickFile(e, 'pdf')" />
        <el-button style="width:100%" @click="$refs.pdfInput.click()">
          {{ recPdf ? '✓ ' + recPdf.name : '选择PDF文件' }}
        </el-button>
      </div>
      <div style="flex:1">
        <div style="margin-bottom:6px; color:#606266">② Excel台账</div>
        <input ref="xlsInput" type="file" accept=".xlsx,.xls" style="display:none" @change="e => pickFile(e, 'xls')" />
        <el-button style="width:100%" @click="$refs.xlsInput.click()">
          {{ recXls ? '✓ ' + recXls.name : '选择Excel台账' }}
        </el-button>
      </div>
      <div style="display:flex; align-items:flex-end">
        <el-button type="primary" :loading="reconciling" :disabled="!recPdf || !recXls" @click="doReconcile">开始核对</el-button>
      </div>
    </div>

    <div v-if="recError" style="margin-bottom:12px">
      <el-alert type="error" :closable="false" :title="recError" />
    </div>

    <div v-if="recResult">
      <el-alert v-if="recResult.po_exists" type="warning" :closable="false" style="margin-bottom:10px"
        :title="`这张PO已经录过了（订单 ${recResult.po_exists}），不能重复录入。`" />
      <el-alert v-else-if="recResult.all_ok" type="success" :closable="false" style="margin-bottom:10px"
        title="✓ 核对通过！PDF与台账完全一致，可以录入。" />
      <el-alert v-else type="error" :closable="false" style="margin-bottom:10px"
        title="✗ 核对未通过，这张单不能录入。请回台账核对下面标红的项后重新上传。" />

      <table class="rec-table">
        <thead><tr><th>核对项</th><th>PDF采购单</th><th>Excel台账</th><th style="width:80px">结果</th></tr></thead>
        <tbody>
          <tr v-for="c in recResult.checks" :key="c.key" :class="{ bad: !c.ok }">
            <td>{{ c.label }}</td>
            <td>{{ c.missing && c.missing_side !== 'ledger' ? '（PDF没抽到）' : fmtVal(c) }}</td>
            <td>{{ c.missing_side === 'ledger' ? '（台账没金额列）' : fmtLedger(c) }}</td>
            <td>
              <span v-if="c.ok" style="color:#67c23a">✓ 一致</span>
              <span v-else style="color:#f56c6c">✗ {{ c.missing ? '缺字段' : '不符' }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:10px; color:#909399; font-size:13px">
        台账对应订单：{{ recResult.ledger.customer_name }} / {{ recResult.ledger.lines.length }}行 / 交期{{ recResult.ledger.due_date || '—' }}。录入以台账为准（含图号、材质、外发等内部信息），PDF会自动留档为附件。
      </div>
    </div>

    <template #footer>
      <el-button @click="reconcileDialog = false">关闭</el-button>
      <el-button v-if="recResult && recResult.all_ok && !recResult.po_exists" type="primary" :loading="importing" @click="doReconcileImport">
        核对通过，确认录入
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="excelDialog" title="Excel台账批量导入" width="960px" top="4vh">
    <div v-if="!excelResult">
      <el-alert type="info" :closable="false" style="margin-bottom: 14px"
        title="支持你们的《客户交期明细表》格式：自动识别每个月份工作表、按「客户+客户单号」分成一张张订单。没见过的客户会自动建档，客户单号已存在的订单默认跳过（防重复导入）。" />
      <input ref="excelInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onExcelPicked" />
      <el-button type="primary" :loading="excelParsing" @click="$refs.excelInput.click()">
        {{ excelParsing ? '正在解析...' : '选择Excel文件' }}
      </el-button>
    </div>
    <div v-else>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span>选择月份工作表：</span>
        <el-select v-model="activeSheet" style="width: 200px" @change="onSheetChange">
          <el-option v-for="s in excelResult.sheets" :key="s.name" :value="s.name"
            :label="`${s.name}（${s.orders.length}张订单）`" />
        </el-select>
        <span style="color:#909399; font-size:13px">勾选要导入的订单；标「已存在」的默认不勾（这个客户单号系统里已有）</span>
      </div>
      <el-table ref="excelTable" :data="sheetOrders" border size="small" max-height="440"
        @selection-change="s => excelSelected = s" row-key="_key">
        <el-table-column type="selection" width="40" reserve-selection />
        <el-table-column type="expand" width="34">
          <template #default="{ row }">
            <el-table :data="row.lines" size="small" style="margin: 4px 12px; width: auto">
              <el-table-column type="index" label="行" width="46" />
              <el-table-column prop="name" label="品名" min-width="130" show-overflow-tooltip />
              <el-table-column prop="drawing_no" label="图号" min-width="130" show-overflow-tooltip />
              <el-table-column prop="spec" label="规格" width="130" show-overflow-tooltip />
              <el-table-column prop="material" label="材质" width="80" />
              <el-table-column prop="qty" label="数量" width="60" align="center" />
              <el-table-column v-if="showPrice" prop="unit_price" label="单价" width="90" align="right" />
              <el-table-column prop="remark" label="备注" min-width="150" show-overflow-tooltip />
            </el-table>
          </template>
        </el-table-column>
        <el-table-column label="客户" min-width="140">
          <template #default="{ row }">
            {{ row.customer_name }}
            <el-tag v-if="!row.customer_exists" type="warning" size="small" style="margin-left:4px">新客户</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="客户单号" min-width="170">
          <template #default="{ row }">
            {{ row.customer_po || '（无单号）' }}
            <el-tag v-if="row.po_exists" type="danger" size="small" style="margin-left:4px">已存在:{{ row.po_exists }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="行数" width="70" align="center">
          <template #default="{ row }">{{ row.lines.length }}</template>
        </el-table-column>
        <el-table-column prop="total_qty" label="总件数" width="80" align="center" />
        <el-table-column prop="due_date" label="交期" width="110">
          <template #default="{ row }">{{ row.due_date || '—' }}</template>
        </el-table-column>
        <el-table-column v-if="showPrice" label="金额" width="110" align="right">
          <template #default="{ row }">{{ fmtMoney(row.amount) }}</template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button v-if="excelResult" @click="excelResult = null">重新上传</el-button>
      <el-button @click="excelDialog = false">取消</el-button>
      <el-button v-if="excelResult" type="primary" :loading="importing" :disabled="!excelSelected.length" @click="doImport">
        导入选中的 {{ excelSelected.length }} 张订单
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, canSeePrice, canEntry } from '../api.js';
import { ORDER_STATUS } from '../consts.js';

const router = useRouter();

const orders = ref([]);
const customers = ref([]);
const loading = ref(false);
const filters = ref({ status: 'active', customer_id: null, month: null, q: '' });
const showPrice = canSeePrice();
const entry = canEntry();
const today = new Date().toISOString().slice(0, 10);

const reconcileDialog = ref(false);
const recPdf = ref(null);
const recXls = ref(null);
const reconciling = ref(false);
const recResult = ref(null);
const recError = ref('');

function openReconcile() {
  recPdf.value = null;
  recXls.value = null;
  recResult.value = null;
  recError.value = '';
  reconcileDialog.value = true;
}

function pickFile(e, which) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (which === 'pdf') recPdf.value = f; else recXls.value = f;
  recResult.value = null;
  recError.value = '';
}

function fmtVal(c) {
  if (c.key === 'amount' && c.pdf != null) return '¥' + Number(c.pdf).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
  if (c.key === 'qty') return c.pdf + ' 件';
  return c.pdf ?? '';
}
function fmtLedger(c) {
  if (c.key === 'amount' && c.ledger != null) return '¥' + Number(c.ledger).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
  if (c.key === 'qty') return c.ledger + ' 件';
  return c.ledger ?? '';
}

async function doReconcile() {
  reconciling.value = true;
  recResult.value = null;
  recError.value = '';
  try {
    const fd = new FormData();
    fd.append('pdf', recPdf.value);
    fd.append('excel', recXls.value);
    const { data } = await api.post('/orders/reconcile', fd);
    recResult.value = data;
  } catch (err) {
    recError.value = err.response?.data?.error || '核对失败';
  } finally {
    reconciling.value = false;
  }
}

async function doReconcileImport() {
  importing.value = true;
  try {
    const fd = new FormData();
    fd.append('pdf', recPdf.value);
    fd.append('excel', recXls.value);
    const { data } = await api.post('/orders/reconcile-import', fd);
    ElMessage.success(`已录入订单 ${data.order_no}（${data.pieces}件）${data.customer_created ? '，并新建了客户' : ''}，PDF已留档`);
    reconcileDialog.value = false;
    load();
    router.push(`/orders/${data.order_id}`);
  } catch { /* 拦截器已提示 */ } finally {
    importing.value = false;
  }
}

const excelDialog = ref(false);
const excelParsing = ref(false);
const excelResult = ref(null);
const activeSheet = ref('');
const excelSelected = ref([]);
const importing = ref(false);
const excelTable = ref(null);

const sheetOrders = computed(() => {
  if (!excelResult.value) return [];
  const s = excelResult.value.sheets.find(x => x.name === activeSheet.value);
  return s ? s.orders : [];
});

function openExcelImport() {
  excelResult.value = null;
  excelSelected.value = [];
  excelDialog.value = true;
}

async function onExcelPicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  excelParsing.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const { data } = await api.post('/orders/parse-excel', fd);
    data.sheets.forEach((s, si) => s.orders.forEach((o, oi) => { o._key = `${si}-${oi}`; }));
    excelResult.value = data;
    const withOrders = data.sheets.filter(s => s.orders.length);
    if (!withOrders.length) {
      ElMessage.warning('这个文件里没有识别到订单数据');
      excelResult.value = null;
      return;
    }
    activeSheet.value = withOrders[withOrders.length - 1].name;
    await preselect();
  } catch { /* 已提示 */ } finally {
    excelParsing.value = false;
  }
}

async function preselect() {
  await nextTick();
  excelTable.value?.clearSelection();
  for (const row of sheetOrders.value) {
    if (!row.po_exists) excelTable.value?.toggleRowSelection(row, true);
  }
}

function onSheetChange() {
  excelSelected.value = [];
  preselect();
}

async function doImport() {
  const sel = excelSelected.value;
  await ElMessageBox.confirm(
    `确认导入 ${sel.length} 张订单（共 ${sel.reduce((s, o) => s + o.total_qty, 0)} 件板）？没见过的客户会自动建档。`,
    '确认导入', { type: 'warning', confirmButtonText: '确认导入' }
  );
  importing.value = true;
  try {
    const { data } = await api.post('/orders/import-excel', {
      orders: sel.map(o => ({
        customer_name: o.customer_name,
        customer_po: o.customer_po,
        due_date: o.due_date,
        lines: o.lines
      }))
    });
    const parts = [`成功创建 ${data.created.length} 张订单（共 ${data.created.reduce((s, c) => s + c.pieces, 0)} 件板）`];
    if (data.customers_created.length) parts.push(`新建客户：${data.customers_created.join('、')}`);
    if (data.skipped.length) parts.push(`跳过 ${data.skipped.length} 张：${data.skipped.map(s => `${s.customer_po || '?'}(${s.reason})`).join('；')}`);
    await ElMessageBox.alert(parts.join('\n'), '导入完成', { confirmButtonText: '好' });
    excelDialog.value = false;
    load();
  } catch { /* 已提示 */ } finally {
    importing.value = false;
  }
}

function fmtMoney(v) {
  if (v == null) return '—';
  return '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function load() {
  loading.value = true;
  try {
    const params = {};
    for (const [k, v] of Object.entries(filters.value)) if (v) params[k] = v;
    const { data } = await api.get('/orders', { params });
    orders.value = data.orders;
  } finally { loading.value = false; }
}

onMounted(async () => {
  load();
  const { data } = await api.get('/customers');
  customers.value = data.customers.filter(c => c.active);
});
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
.prog { color: #606266; font-size: 13px; }
.tag-special { background: #f3eefc !important; border-color: #b39ddb !important; color: #6a3fb5 !important; }
.rec-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rec-table th, .rec-table td { border: 1px solid #ebeef5; padding: 8px 12px; text-align: left; }
.rec-table th { background: #f5f7fa; font-weight: 500; }
.rec-table tr.bad td { background: #fef0f0; }
</style>
