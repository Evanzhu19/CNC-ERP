<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-select v-model="filters.status" style="width: 140px" @change="load">
        <el-option label="全部（未完结优先）" value="" />
        <el-option label="待确认" value="draft" />
        <el-option label="在外（未回齐）" value="open" />
        <el-option label="已回齐" value="done" />
      </el-select>
      <el-select v-model="filters.type" placeholder="全部类型" clearable style="width: 130px" @change="load">
        <el-option label="含铣磨" value="milling" />
        <el-option label="含CNC" value="cnc" />
        <el-option label="含精磨" value="grinding" />
        <el-option label="电镀" value="plating" />
      </el-select>
      <el-button @click="load">刷新</el-button>
      <span style="color:#909399; font-size: 13px; margin-left: 8px">要新建外发单，请到订单详情里勾选板件后点「CNC外发 / 电镀外发」</span>
    </div>

    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="batch_no" label="外发单号" width="110" />
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag :type="String(row.type).includes('plating') ? 'warning' : 'primary'" size="small">{{ outTypeLabel(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="vendor_name" label="外协厂家" min-width="140" />
      <el-table-column prop="sent_date" label="发出日期" width="105" />
      <el-table-column prop="expected_date" label="预计回厂" width="105">
        <template #default="{ row }">
          <span :style="{ color: row.status === 'open' && row.expected_date && row.expected_date < today ? '#f56c6c' : '' }">{{ row.expected_date || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="在外天数" width="90" align="center">
        <template #default="{ row }">
          <span v-if="row.status === 'open'" :style="{ color: row.days_out > 14 ? '#f56c6c' : '' }">{{ row.days_out }} 天</span>
          <span v-else style="color:#909399">—</span>
        </template>
      </el-table-column>
      <el-table-column label="回货" width="90" align="center">
        <template #default="{ row }">{{ row.returned_count }} / {{ row.piece_count }}</template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'draft' ? 'warning' : row.status === 'open' ? 'danger' : 'success'" size="small">
            {{ row.status === 'draft' ? '待确认' : row.status === 'open' ? '在外' : '已回齐' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column width="280">
        <template #default="{ row }">
          <el-button v-if="entry && row.status === 'draft'" text type="success" size="small" @click="confirmBatch(row)">确认外发</el-button>
          <el-button v-if="row.status !== 'draft'" text type="primary" size="small" @click="openDetail(row)">明细/回货</el-button>
          <el-button text type="primary" size="small" @click="printPO(row)">外发单</el-button>
          <el-button text type="primary" size="small" @click="printBatch(row)">交接单</el-button>
          <el-button v-if="entry && row.returned_count === 0" text type="danger" size="small" @click="delBatch(row)">{{ row.status === 'draft' ? '撤销' : '删除' }}</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !rows.length" description="没有外发记录" />
  </el-card>

  <el-dialog v-model="detailDialog" :title="`外发单 ${current?.batch.batch_no || ''} — ${current?.batch.vendor_name || ''}`" width="760px">
    <div v-if="current">
      <p style="margin-top: 0; color: #606266">
        {{ outTypeLabel(current.batch.type) }}外发，{{ current.batch.sent_date }} 发出
        <span v-if="current.batch.expected_date">，预计 {{ current.batch.expected_date }} 回厂</span>
        <span v-if="current.batch.note">。备注：{{ current.batch.note }}</span>
      </p>
      <el-table :data="current.pieces" size="small" border @selection-change="s => returnSel = s" max-height="380">
        <el-table-column type="selection" width="40" :selectable="() => entry" />
        <el-table-column prop="piece_code" label="板件号" width="120" />
        <el-table-column prop="order_no" label="订单号" width="100" />
        <el-table-column prop="customer_name" label="客户" width="120" show-overflow-tooltip />
        <el-table-column prop="part_no" label="编号" width="90" show-overflow-tooltip />
        <el-table-column prop="drawing_no" label="图号" width="100" show-overflow-tooltip />
        <el-table-column prop="spec" label="规格" width="130" show-overflow-tooltip />
        <el-table-column label="回货" width="150">
          <template #default="{ row }">
            <template v-if="row.returned_date">
              <span style="color:#67c23a">{{ row.returned_date }}</span>
              <el-button v-if="entry" text type="danger" size="small" style="padding:2px 4px" @click="unreturnPiece(row)">撤回货</el-button>
            </template>
            <el-tag v-else type="danger" size="small">在外</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="entry" style="margin-top: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <span>回货日期：</span>
        <el-date-picker v-model="returnDate" type="date" value-format="YYYY-MM-DD" style="width: 150px" />
        <el-button type="primary" :disabled="!selOut.length" @click="submitReturn">登记回货（{{ selOut.length }} 件）</el-button>
        <el-button v-if="String(current.batch.type).includes('plating') && current.batch.status === 'open'"
          type="success" plain :disabled="!selOut.length" @click="directShip">直送客户出货（{{ selOut.length }} 件）</el-button>
        <el-button type="warning" plain :disabled="!selOut.length" @click="removePieces">撤件（{{ selOut.length }} 件）</el-button>
        <el-button type="danger" plain :disabled="!selReturned.length" @click="unreturnBatch">撤回货（{{ selReturned.length }} 件）</el-button>
        <div style="color:#909399; font-size: 12px; width: 100%;">
          回货登记后状态自动流转：CNC外发回货自动标CNC完成、精磨外发回货自动标精磨完成、电镀回货自动标电镀回厂。「撤件」用于开了单但实际没拉走的板：撤出后恢复待外发状态。「撤回货」用于登记错了的板：勾选已回货的板批量撤销回货登记。前三个按钮只对勾中的"在外"板生效，撤回货只对勾中的"已回货"板生效。
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, canEntry } from '../api.js';
import { outTypeLabel } from '../consts.js';

const rows = ref([]);
const loading = ref(false);
const filters = ref({ status: '', type: '' });
const entry = canEntry();
const today = new Date().toISOString().slice(0, 10);

const detailDialog = ref(false);
const current = ref(null);
const returnSel = ref([]);
const returnDate = ref(today);
// 勾选自动按状态分流：在外的走登记回货/直送/撤件，已回货的走撤回货
const selOut = computed(() => returnSel.value.filter(p => !p.returned_date));
const selReturned = computed(() => returnSel.value.filter(p => p.returned_date));

async function load() {
  loading.value = true;
  try {
    const params = {};
    if (filters.value.status) params.status = filters.value.status;
    if (filters.value.type) params.type = filters.value.type;
    const { data } = await api.get('/outsourcing', { params });
    rows.value = data.outsourcing;
  } finally { loading.value = false; }
}

async function openDetail(row) {
  const { data } = await api.get(`/outsourcing/${row.id}`);
  current.value = data;
  returnSel.value = [];
  returnDate.value = today;
  detailDialog.value = true;
}

async function submitReturn() {
  await api.post(`/outsourcing/${current.value.batch.id}/return`, {
    piece_ids: selOut.value.map(p => p.piece_id),
    returned_date: returnDate.value
  });
  ElMessage.success('回货已登记');
  await openDetail({ id: current.value.batch.id });
  load();
}

function printBatch(row) {
  window.open(`/print/outsourcing/${row.id}`, '_blank');
}

function printPO(row) {
  window.open(`/print/outsourcing/${row.id}/po`, '_blank');
}

async function unreturnPiece(row) {
  await ElMessageBox.confirm(
    `撤销 ${row.piece_code} 的回货登记？该件恢复"在外"状态，回货时自动标的工序会一并撤掉。`,
    '撤销回货', { type: 'warning', confirmButtonText: '撤销回货' }
  );
  await api.post(`/outsourcing/${current.value.batch.id}/unreturn`, { piece_ids: [row.piece_id] });
  ElMessage.success('回货已撤销');
  await openDetail({ id: current.value.batch.id });
  load();
}

async function unreturnBatch() {
  const n = selReturned.value.length;
  const codes = selReturned.value.slice(0, 5).map(p => p.piece_code).join('、') + (n > 5 ? ` 等${n}件` : '');
  await ElMessageBox.confirm(
    `批量撤销 ${n} 件的回货登记？（${codes}）这些板恢复"在外"状态，回货时自动标的工序会一并撤掉。`,
    '批量撤回货', { type: 'warning', confirmButtonText: `撤回货（${n}件）` }
  );
  await api.post(`/outsourcing/${current.value.batch.id}/unreturn`, {
    piece_ids: selReturned.value.map(p => p.piece_id)
  });
  ElMessage.success(`已撤销 ${n} 件的回货登记`);
  await openDetail({ id: current.value.batch.id });
  load();
}

async function directShip() {
  const { value: shipDate } = await ElMessageBox.prompt(
    `确认这 ${selOut.value.length} 件板由电镀厂（${current.value.batch.vendor_name}）直接送到客户？将一步完成"电镀回厂标记+出货记录"，送货单自动注明直送。请输入出货日期：`,
    '电镀厂直送客户', { inputValue: new Date().toISOString().slice(0, 10), confirmButtonText: '确认直送出货' }
  );
  const { data } = await api.post(`/outsourcing/${current.value.batch.id}/direct-ship`, {
    piece_ids: selOut.value.map(p => p.piece_id),
    ship_date: shipDate
  });
  const nos = data.shipments.map(s => s.ship_no + (s.closed ? '（订单已结案）' : '')).join('、');
  await ElMessageBox.alert(`直送出货完成，生成送货单：${nos}。可到对应订单详情打印送货单。`, '完成');
  await openDetail({ id: current.value.batch.id });
  load();
}

async function removePieces() {
  const codes = selOut.value.map(p => p.piece_code).join('、');
  await ElMessageBox.confirm(
    `把 ${codes} 从这张外发单撤出？撤出后这些板恢复"待外发"状态，可以加入下一张外发单。（用于开了单但实际没拉走的情况）`,
    '确认撤件', { type: 'warning', confirmButtonText: '确认撤件' }
  );
  const { data } = await api.post(`/outsourcing/${current.value.batch.id}/remove`, {
    piece_ids: selOut.value.map(p => p.piece_id)
  });
  if (data.batch_deleted) {
    ElMessage.success('已撤件，该外发单已无板件，单据已删除');
    detailDialog.value = false;
  } else {
    ElMessage.success(`已撤出 ${data.removed} 件`);
    await openDetail({ id: current.value.batch.id });
  }
  load();
}

async function confirmBatch(row) {
  await ElMessageBox.confirm(`确认外发单 ${row.batch_no} 的板已实际发出？确认后板件变为在外状态。`, '确认外发', { type: 'warning', confirmButtonText: '确认已外发' });
  await api.post(`/outsourcing/${row.id}/confirm`);
  ElMessage.success('已确认外发');
  load();
}

async function delBatch(row) {
  const isDraft = row.status === 'draft';
  await ElMessageBox.confirm(
    isDraft ? `撤销外发单 ${row.batch_no}？板件恢复原状态。` : `删除外发单 ${row.batch_no}？（仅用于建错单的情况）`,
    isDraft ? '确认撤销' : '确认删除', { type: 'warning' }
  );
  await api.delete(`/outsourcing/${row.id}`);
  ElMessage.success(isDraft ? '已撤销' : '已删除');
  load();
}

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
</style>
