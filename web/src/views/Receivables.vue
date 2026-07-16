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
          <div class="num-card"><div class="label">应收余额（客户欠我们）</div><div class="num" style="color:#f56c6c">{{ money(summary.balances.receivable.balance) }}</div></div>
          <div class="num-card"><div class="label">应付余额（我们欠供应商）</div><div class="num" style="color:#e6a23c">{{ money(summary.balances.payable.balance) }}</div></div>
          <div class="num-card"><div class="label">净头寸（应收−应付）</div><div class="num" :style="{ color: summary.balances.net >= 0 ? '#67c23a' : '#f56c6c' }">{{ money(summary.balances.net) }}</div></div>
          <div class="num-card"><div class="label">催款中</div><div class="num" style="font-size:20px">{{ summary.balances.receivable.remind_count }} 家 / {{ money(summary.balances.receivable.remind_balance) }}</div></div>
          <div class="num-card"><div class="label">待付款</div><div class="num" style="font-size:20px">{{ summary.balances.payable.remind_count }} 家 / {{ money(summary.balances.payable.remind_balance) }}</div></div>
        </div>

        <div style="display:flex; align-items:center; gap:12px; margin: 18px 0 8px">
          <b>盈亏统计</b>
          <el-radio-group v-model="granularity" size="small" @change="loadSummary">
            <el-radio-button value="month">按月</el-radio-button>
            <el-radio-button value="quarter">按季度</el-radio-button>
            <el-radio-button value="year">按年</el-radio-button>
          </el-radio-group>
          <span style="color:#909399; font-size:12px">收入=本期销售发生额，支出=本期采购发生额（上年结转是期初余额，不算收入支出）；实收/实付按收付款日期统计</span>
        </div>
        <el-table :data="summary.periods" size="small" border>
          <el-table-column prop="period" :label="granularity === 'month' ? '月份' : granularity === 'quarter' ? '季度' : '年度'" width="110" />
          <el-table-column label="收入（销售发生）" align="right" min-width="130">
            <template #default="{ row }">{{ money(row.income) }}</template>
          </el-table-column>
          <el-table-column label="支出（采购发生）" align="right" min-width="130">
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
              <el-table-column label="总应收(含结转)" align="right" width="130"><template #default="{ row }">{{ money(row.amount) }}</template></el-table-column>
              <el-table-column label="欠款余额" align="right" width="120"><template #default="{ row }"><b style="color:#f56c6c">{{ money(row.balance) }}</b></template></el-table-column>
            </el-table>
          </div>
          <div class="biz-box">
            <b>应付 · 按业务类型</b>
            <el-table :data="summary.by_biz.payable" size="small">
              <el-table-column prop="biz" label="业务" min-width="100" />
              <el-table-column label="总应付(含结转)" align="right" width="130"><template #default="{ row }">{{ money(row.amount) }}</template></el-table-column>
              <el-table-column label="应付余额" align="right" width="120"><template #default="{ row }"><b style="color:#e6a23c">{{ money(row.balance) }}</b></template></el-table-column>
            </el-table>
          </div>
        </div>
        <p style="color:#909399; font-size:12px; margin-top:12px">
          提示：工资、水电、房租等固定支出，可以建成应付账户（如单位"房租"）按月记采购流水，盈亏就完整了。
        </p>
      </template>
    </div>

    <!-- ========== 应收 / 应付：往来账户，一家一行 ========== -->
    <div v-else>
      <div class="toolbar">
        <el-input v-model="q" :placeholder="`搜${L.who}`" style="width: 180px" clearable />
        <el-select v-model="filter" style="width: 130px">
          <el-option :label="`有${L.owe}的`" value="owed" />
          <el-option :label="`${L.flag}中的`" value="remind" />
          <el-option label="全部" value="all" />
        </el-select>
        <div style="flex: 1"></div>
        <el-tag v-if="!canEdit" type="info">总经理查看模式（仅财务可操作）</el-tag>
        <template v-if="canEdit">
          <el-button type="success" plain @click="openImport">Excel导入</el-button>
          <el-button type="primary" @click="openAccountForm(null)">+ 新增单位</el-button>
        </template>
      </div>

      <div v-if="totals" class="summary">
        <div class="sum-item"><span>上年结转</span><b>{{ money(totals.opening) }}</b></div>
        <div class="sum-item"><span>累计{{ L.sale }}</span><b>{{ money(totals.sales) }}</b></div>
        <div class="sum-item"><span>累计{{ L.pay }}</span><b style="color:#67c23a">{{ money(totals.paid) }}</b></div>
        <div class="sum-item"><span>{{ L.owe }}合计</span><b style="color:#f56c6c">{{ money(totals.balance) }}</b></div>
        <div class="sum-item"><span>{{ L.flag }}中</span><b style="color:#e6a23c">{{ totals.remind_count }} 家 / {{ money(totals.remind_balance) }}</b></div>
      </div>

      <el-table :data="filtered" v-loading="loading" :row-class-name="rowClass" @row-click="openDetail" style="cursor:pointer">
        <el-table-column :label="L.flag" width="70" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="canEdit" :content="row.remind ? `点击取消${L.flag}标记` : `点击标记为需要${L.flag}`">
              <span class="bell" :class="{ on: row.remind }" @click.stop="toggleRemind(row)">{{ row.remind ? '🔔' : '🔕' }}</span>
            </el-tooltip>
            <span v-else class="bell" :class="{ on: row.remind }" style="cursor: default">{{ row.remind ? '🔔' : '🔕' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="name" :label="L.who" min-width="150" show-overflow-tooltip>
          <template #default="{ row }"><b>{{ row.name }}</b></template>
        </el-table-column>
        <el-table-column prop="biz" label="业务" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.biz" size="small" :type="row.biz.includes('钢') || row.biz.includes('材料') ? 'warning' : 'primary'">{{ row.biz }}</el-tag>
            <span v-else style="color:#c0c4cc">—</span>
          </template>
        </el-table-column>
        <el-table-column label="上年结转" width="120" align="right">
          <template #default="{ row }">{{ row.opening ? money(row.opening) : '—' }}</template>
        </el-table-column>
        <el-table-column :label="`累计${L.sale}`" width="130" align="right">
          <template #default="{ row }">{{ money(row.sales_total) }}</template>
        </el-table-column>
        <el-table-column :label="`累计${L.pay}`" width="130" align="right">
          <template #default="{ row }"><span style="color:#67c23a">{{ money(row.paid_total) }}</span></template>
        </el-table-column>
        <el-table-column :label="`当前${L.owe}`" width="140" align="right">
          <template #default="{ row }">
            <el-tag v-if="Math.abs(row.balance) <= 0.005" type="success" size="small">已结清</el-tag>
            <el-tag v-else-if="row.balance < 0" type="success" size="small" effect="plain">{{ L.prepay }} {{ money(-row.balance) }}</el-tag>
            <b v-else style="color:#f56c6c">{{ money(row.balance) }}</b>
          </template>
        </el-table-column>
        <el-table-column prop="last_txn" label="最近往来" width="105">
          <template #default="{ row }">{{ row.last_txn || '—' }}</template>
        </el-table-column>
        <el-table-column v-if="canEdit" label="操作" width="150">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click.stop="openTxnForm(row, 'sale')">记{{ L.sale }}</el-button>
            <el-button text type="success" size="small" @click.stop="openTxnForm(row, 'payment')">{{ L.pay }}款</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !filtered.length" description="没有符合条件的单位" />
    </div>
  </el-card>

  <!-- 新增/编辑单位 -->
  <el-dialog v-model="accountDialog" :title="(accountForm.id ? '编辑单位 — ' : '新增单位') + (accountForm.id ? accountForm.name : '')" width="440px">
    <el-form label-width="90px">
      <el-form-item :label="L.who" required><el-input v-model="accountForm.name" placeholder="手工填写，不限于系统里的客户/厂家" /></el-form-item>
      <el-form-item label="业务类型">
        <el-select v-model="accountForm.biz" style="width: 100%" clearable filterable allow-create default-first-option placeholder="选一个或直接输入">
          <el-option v-for="b in L.bizOptions" :key="b" :label="b" :value="b" />
        </el-select>
      </el-form-item>
      <el-form-item label="上年结转">
        <el-input-number v-model="accountForm.opening" :precision="2" :controls="false" style="width: 100%" placeholder="期初欠款，没有填0" />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="accountForm.note" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="accountDialog = false">取消</el-button>
      <el-button type="primary" @click="saveAccount">保存</el-button>
    </template>
  </el-dialog>

  <!-- 记流水 -->
  <el-dialog v-model="txnDialog" :title="`${txnForm.type === 'sale' ? '记' + L.sale : '登记' + L.pay + '款'} — ${txnForm.accountName}`" width="420px">
    <el-form label-width="80px">
      <el-form-item label="金额" required>
        <el-input-number v-model="txnForm.amount" :min="0.01" :precision="2" :controls="false" style="width: 100%" />
      </el-form-item>
      <el-form-item label="日期" required>
        <el-date-picker v-model="txnForm.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item v-if="txnForm.type === 'sale'" label="摘要">
        <el-input v-model="txnForm.title" :placeholder="L.titlePh" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="txnDialog = false">取消</el-button>
      <el-button type="primary" @click="saveTxn">保存</el-button>
    </template>
  </el-dialog>

  <!-- 单位明细 -->
  <el-dialog v-model="detailDialog" :title="`往来明细 — ${detail?.account?.name || ''}`" width="760px" top="5vh">
    <div v-if="detail">
      <div class="summary" style="margin-bottom: 12px">
        <div class="sum-item"><span>上年结转</span><b>{{ money(detail.account.opening) }}</b></div>
        <div class="sum-item"><span>累计{{ L.sale }}</span><b>{{ money(detail.account.sales_total) }}</b></div>
        <div class="sum-item"><span>累计{{ L.pay }}</span><b style="color:#67c23a">{{ money(detail.account.paid_total) }}</b></div>
        <div class="sum-item"><span>当前{{ L.owe }}</span>
          <b :style="{ color: detail.account.balance > 0.005 ? '#f56c6c' : '#67c23a' }">{{ money(detail.account.balance) }}</b>
        </div>
      </div>
      <el-table :data="detail.txns" size="small" border max-height="380">
        <el-table-column prop="date" label="日期" width="105" />
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="row.type === 'sale' ? 'primary' : 'success'" size="small">{{ row.type === 'sale' ? L.sale : L.pay + '款' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="130" align="right">
          <template #default="{ row }">
            <span :style="{ color: row.type === 'sale' ? '' : '#67c23a' }">{{ (row.type === 'sale' ? '+' : '-') + money(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="摘要" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.title || '—' }}</template>
        </el-table-column>
        <el-table-column prop="created_by_name" label="经手" width="80" />
        <el-table-column v-if="canEdit" label="" width="60">
          <template #default="{ row }">
            <el-button text type="danger" size="small" @click="delTxn(row)">删</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!detail.txns.length" description="还没有流水" :image-size="40" />
    </div>
    <template #footer>
      <template v-if="canEdit && detail">
        <el-button type="danger" plain @click="delAccount">删除该单位</el-button>
        <el-button @click="openAccountForm(detail.account)">编辑单位</el-button>
        <el-button type="primary" @click="openTxnForm(detail.account, 'sale')">记{{ L.sale }}</el-button>
        <el-button type="success" @click="openTxnForm(detail.account, 'payment')">{{ L.pay }}款</el-button>
      </template>
      <el-button @click="detailDialog = false">关闭</el-button>
    </template>
  </el-dialog>

  <!-- Excel 导入 -->
  <el-dialog v-model="importDialog" :title="`Excel导入 — ${L.name}账款`" width="980px" top="4vh">
    <el-alert type="info" :closable="false" style="margin-bottom: 12px"
      :title="`支持你们的《采购/销售统计表》（单位×月份格式，自动识别上年结转与逐月发生/收付），也支持一行一笔的流水表。已存在的单位默认不勾（防重复导入）。`" />
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:12px">
      <input ref="xlsInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onXlsPicked" />
      <el-button @click="$refs.xlsInput.click()">{{ xlsName || '选择Excel文件' }}</el-button>
      <el-select v-if="impSheets.length > 1" v-model="impSheetIdx" style="width: 200px">
        <el-option v-for="(s, i) in impSheets" :key="i" :label="s.name + (s.error ? '（识别失败）' : ` (${s.accounts.length}家)`)" :value="i" />
      </el-select>
      <el-tag v-if="curSheet && curSheet.mode === 'matrix'" type="success">已识别统计表格式 · {{ curSheet.year }}年</el-tag>
    </div>

    <template v-if="curSheet">
      <el-alert v-if="curSheet.error" type="error" :closable="false" :title="curSheet.error" />
      <template v-else>
        <el-table :data="curSheet.accounts" size="small" border max-height="400" @selection-change="s => impSel = s" ref="impTable">
          <el-table-column type="selection" width="40" />
          <el-table-column prop="name" :label="L.who" min-width="130" show-overflow-tooltip />
          <el-table-column prop="biz" label="业务" width="80" />
          <el-table-column label="上年结转" width="115" align="right">
            <template #default="{ row }">{{ row.opening ? money(row.opening) : '—' }}</template>
          </el-table-column>
          <el-table-column :label="`累计${L.sale}`" width="125" align="right">
            <template #default="{ row }">{{ money(row.sales_total) }}</template>
          </el-table-column>
          <el-table-column :label="`累计${L.pay}`" width="125" align="right">
            <template #default="{ row }">{{ money(row.paid_total) }}</template>
          </el-table-column>
          <el-table-column label="期末余额" width="130" align="right">
            <template #default="{ row }">
              <b :style="{ color: row.balance > 0 ? '#f56c6c' : '#67c23a' }">{{ money(row.balance) }}</b>
            </template>
          </el-table-column>
          <el-table-column prop="txn_count" label="流水" width="70" align="center" />
          <el-table-column label="" width="90">
            <template #default="{ row }">
              <el-tag v-if="row.duplicate" type="warning" size="small">已有账户</el-tag>
            </template>
          </el-table-column>
        </el-table>
        <div style="margin-top:8px; color:#606266">
          已勾选 {{ impSel.length }} 家单位，期末余额合计 {{ money(impSel.reduce((s, r) => s + r.balance, 0)) }}
        </div>
      </template>
    </template>

    <template #footer>
      <el-button @click="importDialog = false">取消</el-button>
      <el-button type="primary" :disabled="!impSel.length" :loading="importing" @click="doImport">导入 {{ impSel.length }} 家</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getUser } from '../api.js';
import { finCall, finUpload } from '../finance-api.js';

// 只有财务能操作；总经理只读（服务端同样强制）
const canEdit = getUser()?.role === 'finance';
const tab = ref('summary');
const todayStr = new Date().toISOString().slice(0, 10);

const L = computed(() => tab.value === 'payable'
  ? { name: '应付', sale: '采购', pay: '付款', payBtn: '付款', owe: '应付', flag: '待付', prepay: '预付', who: '供应商/单位', bizOptions: ['材料', '电镀', '外协加工', '刀具', '房租水电', '工资', '其他'], titlePh: '如：7月钢料一批' }
  : { name: '应收', sale: '销售', pay: '回收', payBtn: '回款', owe: '欠款', flag: '催款', prepay: '预收', who: '客户/单位', bizOptions: ['CNC加工', '模具钢材', '材料', '其他'], titlePh: '如：7月货款 / 大板一批' });

// ===== 总账 =====
const summary = ref(null);
const sumLoading = ref(false);
const granularity = ref('month');

async function loadSummary() {
  sumLoading.value = true;
  try {
    summary.value = await finCall('get', '/finance/summary', { params: { granularity: granularity.value } });
  } finally { sumLoading.value = false; }
}

// ===== 账户列表 =====
const rows = ref([]);
const totals = ref(null);
const loading = ref(false);
const q = ref('');
const filter = ref('owed');

const filtered = computed(() => {
  let r = rows.value;
  if (filter.value === 'owed') r = r.filter(x => x.balance > 0.005 || x.balance < -0.005);
  if (filter.value === 'remind') r = r.filter(x => x.remind && x.balance > 0.005);
  const kw = q.value.trim();
  if (kw) r = r.filter(x => [x.name, x.biz, x.note].some(v => v && v.includes(kw)));
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
    const data = await finCall('get', '/finance/accounts', { params: { kind: tab.value } });
    rows.value = data.accounts;
    totals.value = data.totals;
  } finally { loading.value = false; }
}

watch(tab, t => { if (t === 'summary') loadSummary(); else load(); });

// ===== 单位（账户）=====
const accountDialog = ref(false);
const accountForm = ref({});

function openAccountForm(row) {
  accountForm.value = row
    ? { id: row.id, name: row.name, biz: row.biz, opening: row.opening, note: row.note, remind: row.remind }
    : { name: '', biz: null, opening: 0, note: '' };
  accountDialog.value = true;
}

async function saveAccount() {
  const f = accountForm.value;
  if (!f.name?.trim()) return ElMessage.warning(`请填写${L.value.who}`);
  if (f.id) await finCall('put', `/finance/accounts/${f.id}`, { data: f });
  else await finCall('post', '/finance/accounts', { data: { ...f, kind: tab.value } });
  ElMessage.success('已保存');
  accountDialog.value = false;
  detailDialog.value = false;
  load();
}

async function toggleRemind(row) {
  await finCall('post', `/finance/accounts/${row.id}/remind`);
  load();
}

// ===== 流水 =====
const txnDialog = ref(false);
const txnForm = ref({});

function openTxnForm(account, type) {
  txnForm.value = { accountId: account.id, accountName: account.name, type, amount: type === 'payment' && account.balance > 0 ? account.balance : null, date: todayStr, title: '' };
  txnDialog.value = true;
}

async function saveTxn() {
  const f = txnForm.value;
  if (!(f.amount > 0)) return ElMessage.warning('请填写金额');
  if (!f.date) return ElMessage.warning('请选择日期');
  await finCall('post', `/finance/accounts/${f.accountId}/txns`, { data: { type: f.type, amount: f.amount, date: f.date, title: f.title } });
  ElMessage.success('已入账');
  txnDialog.value = false;
  load();
  if (detailDialog.value && detail.value) refreshDetail(detail.value.account.id);
}

// ===== 明细 =====
const detailDialog = ref(false);
const detail = ref(null);

async function refreshDetail(id) {
  detail.value = await finCall('get', `/finance/accounts/${id}`);
}

async function openDetail(row) {
  await refreshDetail(row.id);
  detailDialog.value = true;
}

async function delTxn(row) {
  await ElMessageBox.confirm(`删除这笔 ${money(row.amount)}（${row.date}）的流水？余额会相应变化。`, '确认删除', { type: 'warning' });
  await finCall('delete', `/finance/txns/${row.id}`);
  ElMessage.success('已删除');
  await refreshDetail(detail.value.account.id);
  load();
}

async function delAccount() {
  const a = detail.value.account;
  await ElMessageBox.confirm(`删除单位「${a.name}」及其全部 ${detail.value.txns.length} 条流水？不可恢复！`, '确认删除', { type: 'warning', confirmButtonText: '删除' });
  await finCall('delete', `/finance/accounts/${a.id}`);
  ElMessage.success('已删除');
  detailDialog.value = false;
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
  const data = await finUpload('/finance/parse-excel', f, { kind: tab.value });
  impSheets.value = data.sheets;
  impSheetIdx.value = Math.max(0, data.sheets.findIndex(s => !s.error && s.accounts.length));
  await nextTick();
  preselect();
}

watch(impSheetIdx, async () => { await nextTick(); preselect(); });

function preselect() {
  const t = impTable.value;
  if (!t || !curSheet.value?.accounts) return;
  t.clearSelection();
  for (const a of curSheet.value.accounts) {
    if (!a.duplicate) t.toggleRowSelection(a, true);
  }
}

async function doImport() {
  importing.value = true;
  try {
    const data = await finCall('post', '/finance/import', { data: { kind: tab.value, accounts: impSel.value } });
    let msg = `已导入 ${data.imported} 家单位、${data.txns} 条流水`;
    if (data.skipped?.length) msg += `；跳过已存在的 ${data.skipped.length} 家`;
    ElMessage({ message: msg, type: 'success', duration: 6000 });
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
.biz-box { flex: 1; min-width: 340px; }
.biz-box b { display: block; margin-bottom: 8px; }
.bell { cursor: pointer; font-size: 16px; opacity: 0.35; }
.bell.on { opacity: 1; }
:deep(.remind-row) td { background: #fdf6e3 !important; }
</style>
