<template>
  <el-card shadow="never">
    <el-tabs v-model="tab">
      <el-tab-pane label="总账" name="summary" />
      <el-tab-pane label="应收账款" name="receivable" />
      <el-tab-pane label="应付账款" name="payable" />
    </el-tabs>

    <!-- ========== 总账 ========== -->
    <div v-if="tab === 'summary'" v-loading="sumLoading">
      <template v-if="summary">
        <div class="cards">
          <div class="num-card"><div class="label">应收未收</div><div class="num" style="color:#f56c6c">{{ money(summary.balances.receivable.balance) }}</div></div>
          <div class="num-card"><div class="label">应付未付</div><div class="num" style="color:#e6a23c">{{ money(summary.balances.payable.balance) }}</div></div>
          <div class="num-card"><div class="label">净头寸（应收−应付）</div><div class="num" :style="{ color: summary.balances.net >= 0 ? '#67c23a' : '#f56c6c' }">{{ money(summary.balances.net) }}</div></div>
          <div class="num-card"><div class="label">催款中</div><div class="num" style="font-size:20px">{{ summary.balances.receivable.remind_count }} 笔 / {{ money(summary.balances.receivable.remind_balance) }}</div></div>
          <div class="num-card"><div class="label">待付款</div><div class="num" style="font-size:20px">{{ summary.balances.payable.remind_count }} 笔 / {{ money(summary.balances.payable.remind_balance) }}</div></div>
        </div>

        <div style="display:flex; align-items:center; gap:12px; margin: 18px 0 8px">
          <b>盈亏统计</b>
          <el-radio-group v-model="granularity" size="small" @change="loadSummary">
            <el-radio-button value="month">按月</el-radio-button>
            <el-radio-button value="quarter">按季度</el-radio-button>
            <el-radio-button value="year">按年</el-radio-button>
          </el-radio-group>
          <span style="color:#909399; font-size:12px">收入=新增应收记账，支出=新增应付记账；实收/实付按登记收付款的日期统计</span>
        </div>
        <el-table :data="summary.periods" size="small" border>
          <el-table-column prop="period" :label="granularity === 'month' ? '月份' : granularity === 'quarter' ? '季度' : '年度'" width="110" />
          <el-table-column label="收入（新增应收）" align="right" min-width="130">
            <template #default="{ row }">{{ money(row.income) }}</template>
          </el-table-column>
          <el-table-column label="支出（新增应付）" align="right" min-width="130">
            <template #default="{ row }">{{ money(row.expense) }}</template>
          </el-table-column>
          <el-table-column label="盈亏" align="right" min-width="130">
            <template #default="{ row }">
              <b :style="{ color: row.profit >= 0 ? '#67c23a' : '#f56c6c' }">{{ (row.profit >= 0 ? '+' : '') + money(row.profit) }}</b>
            </template>
          </el-table-column>
          <el-table-column label="实收" align="right" min-width="120">
            <template #default="{ row }">{{ money(row.cash_in) }}</template>
          </el-table-column>
          <el-table-column label="实付" align="right" min-width="120">
            <template #default="{ row }">{{ money(row.cash_out) }}</template>
          </el-table-column>
          <el-table-column label="净现金流" align="right" min-width="120">
            <template #default="{ row }">
              <span :style="{ color: row.net_cash >= 0 ? '#67c23a' : '#f56c6c' }">{{ (row.net_cash >= 0 ? '+' : '') + money(row.net_cash) }}</span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!summary.periods.length" description="还没有账目记录" :image-size="50" />

        <div class="biz-wrap">
          <div class="biz-box">
            <b>应收 · 按业务类型</b>
            <el-table :data="summary.by_biz.receivable" size="small">
              <el-table-column prop="biz" label="业务" min-width="100" />
              <el-table-column label="应收" align="right" width="120"><template #default="{ row }">{{ money(row.amount) }}</template></el-table-column>
              <el-table-column label="未收" align="right" width="120"><template #default="{ row }"><b style="color:#f56c6c">{{ money(row.balance) }}</b></template></el-table-column>
            </el-table>
          </div>
          <div class="biz-box">
            <b>应付 · 按业务类型</b>
            <el-table :data="summary.by_biz.payable" size="small">
              <el-table-column prop="biz" label="业务" min-width="100" />
              <el-table-column label="应付" align="right" width="120"><template #default="{ row }">{{ money(row.amount) }}</template></el-table-column>
              <el-table-column label="未付" align="right" width="120"><template #default="{ row }"><b style="color:#e6a23c">{{ money(row.balance) }}</b></template></el-table-column>
            </el-table>
          </div>
        </div>
        <p style="color:#909399; font-size:12px; margin-top:12px">
          提示：想让盈亏更完整，把工资、水电、房租等固定支出也记成「应付账款」（业务类型选/填对应项）即可计入支出。
        </p>
      </template>
    </div>

    <!-- ========== 应收 / 应付 台账 ========== -->
    <div v-else>
      <div class="toolbar">
        <el-input v-model="q" :placeholder="`搜${L.who}/事由/备注`" style="width: 200px" clearable />
        <el-select v-model="filter" style="width: 130px">
          <el-option :label="`${L.owe}清的`" value="owed" />
          <el-option :label="`${L.flag}中的`" value="remind" />
          <el-option label="全部" value="all" />
        </el-select>
        <div style="flex: 1"></div>
        <el-tag v-if="!canEdit" type="info">总经理查看模式（仅财务可操作）</el-tag>
        <template v-if="canEdit">
          <el-button type="success" plain @click="openImport">Excel导入</el-button>
          <el-button type="primary" @click="openForm(null)">+ 记一笔{{ L.name }}</el-button>
        </template>
      </div>

      <div v-if="totals" class="summary">
        <div class="sum-item"><span>{{ L.name }}合计</span><b>{{ money(totals.amount) }}</b></div>
        <div class="sum-item"><span>{{ L.done }}合计</span><b style="color:#67c23a">{{ money(totals.received) }}</b></div>
        <div class="sum-item"><span>{{ L.owe }}余额</span><b style="color:#f56c6c">{{ money(totals.balance) }}</b></div>
        <div class="sum-item"><span>{{ L.flag }}中</span><b style="color:#e6a23c">{{ totals.remind_count }} 笔 / {{ money(totals.remind_balance) }}</b></div>
      </div>

      <el-table :data="filtered" v-loading="loading" :row-class-name="rowClass">
        <el-table-column :label="L.flag" width="70" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="canEdit" :content="row.remind ? `点击取消${L.flag}标记` : `点击标记为需要${L.flag}`">
              <span class="bell" :class="{ on: row.remind }" @click="toggleRemind(row)">{{ row.remind ? '🔔' : '🔕' }}</span>
            </el-tooltip>
            <span v-else class="bell" :class="{ on: row.remind }" style="cursor: default">{{ row.remind ? '🔔' : '🔕' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="customer" :label="L.who" min-width="140" show-overflow-tooltip />
        <el-table-column prop="biz" label="业务" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.biz" size="small" :type="row.biz.includes('钢') ? 'warning' : row.biz.includes('CNC') ? 'primary' : 'info'">{{ row.biz }}</el-tag>
            <span v-else style="color:#c0c4cc">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="事由" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.title || '—' }}</template>
        </el-table-column>
        <el-table-column :label="L.name" width="120" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column :label="L.done" width="120" align="right">
          <template #default="{ row }"><span style="color:#67c23a">{{ money(row.received) }}</span></template>
        </el-table-column>
        <el-table-column :label="L.owe" width="130" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.balance <= 0.005" type="success" size="small">{{ L.settle }}</el-tag>
            <b v-else style="color:#f56c6c">{{ money(row.balance) }}</b>
          </template>
        </el-table-column>
        <el-table-column prop="entry_date" label="记账日期" width="105" />
        <el-table-column prop="due_date" :label="`约定${L.act}`" width="105">
          <template #default="{ row }">
            <span :style="{ color: row.due_date && row.due_date < todayStr && row.balance > 0.005 ? '#f56c6c' : '' }">{{ row.due_date || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.note || '—' }}</template>
        </el-table-column>
        <el-table-column v-if="canEdit" label="操作" width="150">
          <template #default="{ row }">
            <el-button v-if="row.balance > 0.005" text type="success" size="small" @click="receive(row)">{{ L.act }}</el-button>
            <el-button text type="primary" size="small" @click="openForm(row)">编辑</el-button>
            <el-button text type="danger" size="small" @click="del(row)">删</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !filtered.length" description="没有符合条件的记录" />
    </div>
  </el-card>

  <!-- 记账/编辑 -->
  <el-dialog v-model="formDialog" :title="(form.id ? '编辑' : '记一笔') + L.name" width="460px">
    <el-form label-width="90px">
      <el-form-item :label="L.who" required>
        <el-input v-model="form.customer" placeholder="手工填写，不限于系统里的客户/厂家" />
      </el-form-item>
      <el-form-item label="业务类型">
        <el-select v-model="form.biz" style="width: 100%" clearable filterable allow-create default-first-option placeholder="选一个或直接输入">
          <el-option v-for="b in L.bizOptions" :key="b" :label="b" :value="b" />
        </el-select>
      </el-form-item>
      <el-form-item label="事由">
        <el-input v-model="form.title" :placeholder="L.titlePh" />
      </el-form-item>
      <el-form-item :label="L.name + '金额'" required>
        <el-input-number v-model="form.amount" :min="0.01" :precision="2" :controls="false" style="width: 100%" />
      </el-form-item>
      <el-form-item v-if="form.id" :label="L.done + '金额'">
        <el-input-number v-model="form.received" :min="0" :precision="2" :controls="false" style="width: 100%" />
      </el-form-item>
      <el-form-item label="记账日期" required>
        <el-date-picker v-model="form.entry_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="`约定${L.act}`">
        <el-date-picker v-model="form.due_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" placeholder="可不填" />
      </el-form-item>
      <el-form-item :label="L.flag + '标记'">
        <el-switch v-model="form.remind" :active-text="`需要${L.flag}`" />
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

  <!-- Excel 导入 -->
  <el-dialog v-model="importDialog" :title="`Excel导入 — ${L.name}账款`" width="980px" top="4vh">
    <el-alert type="info" :closable="false" style="margin-bottom: 12px"
      :title="`自动识别表头（${L.who}、金额、日期等列名）。疑似重复的行（同单位同金额同日期已在账上）默认不勾选。识别得不准就把账本发我调一版。`" />
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:12px">
      <input ref="xlsInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onXlsPicked" />
      <el-button @click="$refs.xlsInput.click()">{{ xlsName || '选择Excel文件' }}</el-button>
      <el-select v-if="impSheets.length > 1" v-model="impSheetIdx" style="width: 180px">
        <el-option v-for="(s, i) in impSheets" :key="i" :label="s.name + (s.error ? '（识别失败）' : ` (${s.lines.length}条)`)" :value="i" />
      </el-select>
      <span v-if="curSheet && curSheet.skipped?.length" style="color:#e6a23c; font-size:13px">
        跳过 {{ curSheet.skipped.length }} 行（缺单位或金额）
      </span>
    </div>

    <template v-if="curSheet">
      <el-alert v-if="curSheet.error" type="error" :closable="false" :title="curSheet.error" />
      <template v-else>
        <el-table :data="curSheet.lines" size="small" border max-height="420" @selection-change="s => impSel = s" ref="impTable">
          <el-table-column type="selection" width="40" />
          <el-table-column label="客户/单位" prop="customer" min-width="130" show-overflow-tooltip />
          <el-table-column label="业务" prop="biz" width="90" />
          <el-table-column label="事由" prop="title" min-width="130" show-overflow-tooltip />
          <el-table-column label="金额" width="110" align="right">
            <template #default="{ row }">{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column :label="L.done" width="100" align="right">
            <template #default="{ row }">{{ row.received ? money(row.received) : '—' }}</template>
          </el-table-column>
          <el-table-column label="记账日期" width="105">
            <template #default="{ row }">{{ row.entry_date || '（今天）' }}</template>
          </el-table-column>
          <el-table-column label="约定日期" prop="due_date" width="105">
            <template #default="{ row }">{{ row.due_date || '—' }}</template>
          </el-table-column>
          <el-table-column label="备注" prop="note" min-width="100" show-overflow-tooltip />
          <el-table-column label="" width="90">
            <template #default="{ row }">
              <el-tag v-if="row.duplicate" type="warning" size="small">疑似重复</el-tag>
            </template>
          </el-table-column>
        </el-table>
        <div style="margin-top:8px; color:#606266">已勾选 {{ impSel.length }} 条，合计 {{ money(impSel.reduce((s, r) => s + r.amount, 0)) }}</div>
      </template>
    </template>

    <template #footer>
      <el-button @click="importDialog = false">取消</el-button>
      <el-button type="primary" :disabled="!impSel.length" :loading="importing" @click="doImport">导入 {{ impSel.length }} 条</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, getUser } from '../api.js';

// 只有财务能操作；总经理只读（服务端同样强制）
const canEdit = getUser()?.role === 'finance';
const tab = ref('summary');
const todayStr = new Date().toISOString().slice(0, 10);

// 应收/应付 文案
const L = computed(() => tab.value === 'payable'
  ? { name: '应付', done: '已付', owe: '未付', settle: '已付清', act: '付款', flag: '待付', who: '供应商/单位', bizOptions: ['材料', '电镀', '外协加工', '刀具', '房租水电', '工资', '其他'], titlePh: '如：7月份材料款 / 电镀加工费' }
  : { name: '应收', done: '已收', owe: '未收', settle: '已收清', act: '收款', flag: '催款', who: '客户/单位', bizOptions: ['CNC加工', '模具钢材', '其他'], titlePh: '如：6月份货款 / S50C钢料一批' });

// ===== 总账 =====
const summary = ref(null);
const sumLoading = ref(false);
const granularity = ref('month');

async function loadSummary() {
  sumLoading.value = true;
  try {
    const { data } = await api.get('/finance/summary', { params: { granularity: granularity.value } });
    summary.value = data;
  } finally { sumLoading.value = false; }
}

// ===== 台账 =====
const rows = ref([]);
const totals = ref(null);
const loading = ref(false);
const q = ref('');
const filter = ref('owed');
const formDialog = ref(false);
const form = ref({});

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
    const { data } = await api.get('/finance/entries', { params: { kind: tab.value } });
    rows.value = data.entries;
    totals.value = data.totals;
  } finally { loading.value = false; }
}

watch(tab, t => { if (t === 'summary') loadSummary(); else load(); });

function openForm(row) {
  form.value = row
    ? { id: row.id, customer: row.customer, biz: row.biz, title: row.title, amount: row.amount, received: row.received, entry_date: row.entry_date, due_date: row.due_date, remind: !!row.remind, note: row.note }
    : { customer: '', biz: null, title: '', amount: null, entry_date: todayStr, due_date: null, remind: false, note: '' };
  formDialog.value = true;
}

async function save() {
  const f = form.value;
  if (!f.customer?.trim()) return ElMessage.warning(`请填写${L.value.who}`);
  if (!(f.amount > 0)) return ElMessage.warning('请填写金额');
  if (!f.entry_date) return ElMessage.warning('请选择记账日期');
  if (f.id) await api.put(`/finance/entries/${f.id}`, { ...f, kind: tab.value });
  else await api.post('/finance/entries', { ...f, kind: tab.value });
  ElMessage.success('已保存');
  formDialog.value = false;
  load();
}

async function receive(row) {
  const { value } = await ElMessageBox.prompt(
    `「${row.customer}」还差 ${money(row.balance)}，本次${L.value.act}多少？`,
    `登记${L.value.act}`,
    { inputValue: String(row.balance), inputPattern: /^\d+(\.\d{1,2})?$/, inputErrorMessage: '请输入金额', confirmButtonText: '登记' }
  );
  await api.post(`/finance/entries/${row.id}/receive`, { amount: Number(value) });
  ElMessage.success(`${L.value.act}已登记`);
  load();
}

async function toggleRemind(row) {
  await api.post(`/finance/entries/${row.id}/remind`);
  load();
}

async function del(row) {
  await ElMessageBox.confirm(`删除「${row.customer}」这笔 ${money(row.amount)} 的${L.value.name}记录？`, '确认删除', { type: 'warning' });
  await api.delete(`/finance/entries/${row.id}`);
  ElMessage.success('已删除');
  load();
}

// ===== Excel 导入 =====
const importDialog = ref(false);
const impSheets = ref([]);
const impSheetIdx = ref(0);
const impSel = ref([]);
const importing = ref(false);
const xlsName = ref('');
const impTable = ref(null);

const curSheet = computed(() => impSheets.value[impSheetIdx.value] || null);

function openImport() {
  impSheets.value = [];
  impSel.value = [];
  xlsName.value = '';
  importDialog.value = true;
}

async function onXlsPicked(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  xlsName.value = f.name;
  const fd = new FormData();
  fd.append('file', f);
  const { data } = await api.post(`/finance/parse-excel?kind=${tab.value}`, fd);
  impSheets.value = data.sheets;
  impSheetIdx.value = Math.max(0, data.sheets.findIndex(s => !s.error && s.lines.length));
  await nextTick();
  preselect();
}

watch(impSheetIdx, async () => { await nextTick(); preselect(); });

function preselect() {
  const t = impTable.value;
  if (!t || !curSheet.value?.lines) return;
  t.clearSelection();
  for (const l of curSheet.value.lines) {
    if (!l.duplicate) t.toggleRowSelection(l, true);
  }
}

async function doImport() {
  importing.value = true;
  try {
    const { data } = await api.post('/finance/import', { kind: tab.value, entries: impSel.value });
    ElMessage.success(`已导入 ${data.imported} 条`);
    importDialog.value = false;
    load();
  } finally { importing.value = false; }
}

onMounted(loadSummary);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
.summary { display: flex; gap: 28px; padding: 10px 14px; background: #f5f7fa; border-radius: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.sum-item span { color: #909399; font-size: 13px; margin-right: 8px; }
.sum-item b { font-size: 16px; }
.cards { display: flex; gap: 14px; flex-wrap: wrap; }
.num-card { flex: 1; min-width: 170px; background: #f5f7fa; border-radius: 8px; padding: 14px 18px; }
.num-card .label { color: #909399; font-size: 13px; margin-bottom: 6px; }
.num-card .num { font-size: 24px; font-weight: bold; }
.biz-wrap { display: flex; gap: 20px; margin-top: 18px; flex-wrap: wrap; }
.biz-box { flex: 1; min-width: 320px; }
.biz-box b { display: block; margin-bottom: 8px; }
.bell { cursor: pointer; font-size: 16px; opacity: 0.35; }
.bell.on { opacity: 1; }
:deep(.remind-row) td { background: #fdf6e3 !important; }
</style>
