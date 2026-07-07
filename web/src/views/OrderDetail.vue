<template>
  <div v-if="detail" v-loading="loading">
    <el-card shadow="never">
      <template #header>
        <div style="display: flex; align-items: center; gap: 10px;">
          <el-button @click="$router.push('/orders')">
            <el-icon style="margin-right: 4px"><ArrowLeft /></el-icon>返回订单列表
          </el-button>
          <b style="font-size: 16px">订单 {{ detail.order.order_no }}</b>
          <el-tag :type="ORDER_STATUS[detail.order.status].type">{{ ORDER_STATUS[detail.order.status].label }}</el-tag>
          <div style="flex: 1"></div>
          <template v-if="entry">
            <el-button size="small" @click="$router.push(`/orders/${detail.order.id}/edit`)">编辑订单</el-button>
            <el-button v-if="detail.order.status === 'active'" size="small" type="warning" plain @click="setStatus('closed')">手动结案</el-button>
            <el-button v-if="detail.order.status === 'closed'" size="small" plain @click="setStatus('active')">重新打开</el-button>
            <el-button v-if="detail.order.status === 'closed' && isAdmin" size="small" type="danger" plain @click="deleteClosedOrder">删除订单（需授权）</el-button>
            <el-button v-if="detail.order.status === 'active'" size="small" type="danger" plain @click="setStatus('void')">作废</el-button>
          </template>
        </div>
      </template>
      <el-alert v-if="detail.order.status === 'void'" type="error" :closable="false" style="margin-bottom: 12px">
        <template #title>
          此订单已作废，{{ voidDaysLeft }} 天后将自动彻底删除（含明细、板件记录和图纸附件）。
          <el-button v-if="canHardDelete" type="danger" size="small" style="margin-left: 12px" @click="hardDelete">现在直接删除</el-button>
        </template>
      </el-alert>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="客户">{{ detail.order.customer_name }}</el-descriptions-item>
        <el-descriptions-item label="客户PO">{{ detail.order.customer_po || '—' }}</el-descriptions-item>
        <el-descriptions-item label="下单日期">{{ detail.order.order_date }}</el-descriptions-item>
        <el-descriptions-item label="交期">{{ detail.order.due_date || '—' }}</el-descriptions-item>
        <el-descriptions-item label="总件数">{{ allPieces.length }} 件</el-descriptions-item>
        <el-descriptions-item label="已出货">{{ shippedCount }} 件</el-descriptions-item>
        <el-descriptions-item v-if="showPrice" label="订单金额">
          <b style="color: #d4380d">{{ detail.order.amount != null ? '¥' + detail.order.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—' }}</b>
        </el-descriptions-item>
        <el-descriptions-item label="备注" :span="showPrice ? 1 : 2">{{ detail.order.remark || '—' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card shadow="never" style="margin-top: 14px;">
      <template #header>
        <div style="display: flex; align-items: center; gap: 8px;">
          <b>板件进度</b>
          <span style="color: #909399; font-size: 13px">勾选板件后进行操作，已选 {{ selected.length }} 件</span>
          <div style="flex: 1"></div>
          <template v-if="entry && detail.order.status !== 'void'">
            <el-button size="small" color="#409eff" plain :disabled="!selected.length" @click="openStart">开工</el-button>
            <el-button size="small" type="primary" :disabled="!selected.length" @click="openProgress">报工</el-button>
            <el-button size="small" :disabled="!selected.length" @click="openOutsource('cnc')">CNC外发</el-button>
            <el-button size="small" :disabled="!selected.length" @click="openOutsource('grinding')">精磨外发</el-button>
            <el-button size="small" :disabled="!selected.length" @click="openOutsource('plating')">电镀外发</el-button>
            <el-button size="small" type="success" :disabled="!selected.length" @click="openShip">出货</el-button>
            <el-button size="small" type="danger" plain :disabled="!selected.length" @click="openUndo">撤销工序</el-button>
          </template>
        </div>
      </template>

      <el-table :data="pieceRows" border size="small" @selection-change="s => selected = s" row-key="id">
        <el-table-column type="selection" width="40" :selectable="() => entry && detail.order.status !== 'void'" reserve-selection />
        <el-table-column label="板件号" width="130" fixed>
          <template #default="{ row }">
            <a href="javascript:;" style="color:#409eff; text-decoration:none" @click.stop="openTimeline(row)">{{ row.piece_code }}</a>
          </template>
        </el-table-column>
        <el-table-column prop="part_no" label="编号" width="100" show-overflow-tooltip />
        <el-table-column prop="drawing_no" label="图号" width="110" show-overflow-tooltip />
        <el-table-column prop="item_name" label="品名" width="110" show-overflow-tooltip />
        <el-table-column prop="spec" label="规格" width="140" show-overflow-tooltip />
        <el-table-column prop="material" label="材质" width="90" show-overflow-tooltip />
        <el-table-column label="铣磨" width="100" align="center">
          <template #default="{ row }"><span class="done" v-if="row.stages.milling">{{ row.stages.milling.done_date.slice(5) }}</span><span v-else class="pending">—</span></template>
        </el-table-column>
        <el-table-column label="CNC" width="110" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.cncOut" :content="`外发单 ${row.cncOut.batch_no}：${row.cncOut.vendor_name}${row.cncOut.note ? '（' + row.cncOut.note + '）' : ''}`">
              <el-tag type="warning" size="small" :effect="row.cncOut.status === 'draft' ? 'plain' : 'light'">{{ row.cncOut.status === 'draft' ? '待确认' : '外发中' }}</el-tag>
            </el-tooltip>
            <el-tooltip v-else-if="row.stages.cnc" :content="row.stages.cnc.note || 'CNC完成'">
              <span class="done">{{ row.stages.cnc.done_date.slice(5) }}</span>
            </el-tooltip>
            <span v-else class="pending">—</span>
          </template>
        </el-table-column>
        <el-table-column label="精磨" width="100" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.grindOut" :content="`外发单 ${row.grindOut.batch_no}：${row.grindOut.vendor_name}`">
              <el-tag type="warning" size="small" :effect="row.grindOut.status === 'draft' ? 'plain' : 'light'">{{ row.grindOut.status === 'draft' ? '待确认' : '外发中' }}</el-tag>
            </el-tooltip>
            <el-tooltip v-else-if="row.stages.grinding" :content="row.stages.grinding.note || '精磨完成'">
              <span class="done">{{ row.stages.grinding.done_date.slice(5) }}</span>
            </el-tooltip>
            <span v-else class="pending">—</span>
          </template>
        </el-table-column>
        <el-table-column label="电镀" width="120" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.platingOut" :content="`外发单 ${row.platingOut.batch_no}：${row.platingOut.vendor_name}`">
              <el-tag type="warning" size="small" :effect="row.platingOut.status === 'draft' ? 'plain' : 'light'">{{ row.platingOut.status === 'draft' ? '待确认' : '电镀中' }}</el-tag>
            </el-tooltip>
            <span v-else-if="row.stages.plating_back" class="done">回 {{ row.stages.plating_back.done_date.slice(5) }}</span>
            <span v-else class="pending">—</span>
          </template>
        </el-table-column>
        <el-table-column label="出货" width="110" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.stages.shipped" :content="row.stages.shipped.note || ''">
              <span class="done">{{ row.stages.shipped.done_date.slice(5) }}</span>
            </el-tooltip>
            <span v-else class="pending">—</span>
          </template>
        </el-table-column>
        <el-table-column label="当前状态" min-width="140">
          <template #default="{ row }">
            <el-tooltip v-if="row.statusTag.wip" :content="`开工日期 ${row.wip_date}${row.wip_note ? '，' + row.wip_note : ''}`">
              <el-tag :type="row.statusTag.type" size="small" effect="dark">{{ row.statusTag.label }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="row.statusTag.type" size="small">{{ row.statusTag.label }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="14" style="margin-top: 14px;">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center;">
              <b>图纸与附件</b>
              <div style="flex: 1"></div>
              <el-upload v-if="entry" :action="`/api/orders/${detail.order.id}/attachments`" :headers="{ Authorization: 'Bearer ' + tk }"
                name="files" multiple :show-file-list="false" :on-success="load" :on-error="uploadError">
                <el-button size="small" type="primary" plain>上传附件</el-button>
              </el-upload>
            </div>
          </template>
          <el-table :data="detail.attachments" size="small">
            <el-table-column prop="orig_name" label="文件名" show-overflow-tooltip>
              <template #default="{ row }">
                <a :href="`/api/attachments/${row.id}/download?token=${tk}`" target="_blank" style="color: #409eff; text-decoration: none">{{ row.orig_name }}</a>
              </template>
            </el-table-column>
            <el-table-column prop="uploaded_by_name" label="上传人" width="90" />
            <el-table-column label="大小" width="90">
              <template #default="{ row }">{{ (row.size / 1024 / 1024).toFixed(2) }} MB</template>
            </el-table-column>
            <el-table-column v-if="entry" width="60">
              <template #default="{ row }">
                <el-button text type="danger" size="small" @click="delAttachment(row)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!detail.attachments.length" description="还没有上传图纸" :image-size="50" />
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header><b>出货记录</b></template>
          <el-table :data="detail.shipments" size="small">
            <el-table-column prop="ship_no" label="送货单号" width="110" />
            <el-table-column prop="ship_date" label="日期" width="100" />
            <el-table-column prop="piece_count" label="件数" width="60" />
            <el-table-column prop="note" label="备注" show-overflow-tooltip />
            <el-table-column width="130">
              <template #default="{ row }">
                <el-button text type="primary" size="small" @click="openPrint(row.id)">打印</el-button>
                <el-button v-if="entry" text type="danger" size="small" @click="delShipment(row)">撤销</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!detail.shipments.length" description="还没有出货" :image-size="50" />
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="timelineDialog" :title="`板件履历：${timelinePiece?.piece_code || ''}`" width="560px">
      <div v-if="timelinePiece" style="color:#606266; margin-bottom: 14px;">
        {{ timelinePiece.part_no || '' }} {{ timelinePiece.drawing_no || '' }} {{ timelinePiece.item_name || '' }}
        {{ timelinePiece.spec || '' }} {{ timelinePiece.material || '' }}
      </div>
      <el-timeline>
        <el-timeline-item v-for="(ev, i) in timelineEvents" :key="i" :timestamp="ev.date" placement="top"
          :type="ev.type" :hollow="i < timelineEvents.length - 1 ? false : true">
          <b>{{ ev.label }}</b>
          <div v-if="ev.note" style="color:#909399; font-size:12px">{{ ev.note }}</div>
          <div v-if="ev.by" style="color:#c0c4cc; font-size:12px">{{ ev.by }} 录入于 {{ ev.recorded_at }}</div>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-if="!timelineEvents.length" description="这块板还没有任何记录" :image-size="50" />
    </el-dialog>

    <el-dialog v-model="startDialog" :title="`开工标记（已选 ${selected.length} 件）`" width="460px">
      <el-form label-width="80px">
        <el-form-item label="工序">
          <el-radio-group v-model="startForm.stage">
            <el-radio-button value="milling">铣磨</el-radio-button>
            <el-radio-button value="cnc">CNC（本厂）</el-radio-button>
            <el-radio-button value="grinding">精磨</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="开工日期">
          <el-date-picker v-model="startForm.start_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="startForm.note" placeholder="如：6米机、夜班（会显示在状态里）" />
        </el-form-item>
        <el-alert type="info" :closable="false" title="开工=标记这些板现在正在这道工序上。做完报工后自动清除；标错了可用「取消开工」。CNC外发的板不用开工，直接点「CNC外发」。" />
      </el-form>
      <template #footer>
        <el-button v-if="selectedHasWip" type="warning" plain @click="clearWip">取消开工（清除标记）</el-button>
        <el-button @click="startDialog = false">取消</el-button>
        <el-button type="primary" @click="submitStart">标记开工</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="progressDialog" :title="`报工（已选 ${selected.length} 件）`" width="440px">
      <el-form label-width="80px">
        <el-form-item label="工序">
          <el-radio-group v-model="progressForm.stage">
            <el-radio-button value="milling">铣磨</el-radio-button>
            <el-radio-button value="cnc">CNC完成</el-radio-button>
            <el-radio-button value="grinding">精磨</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="完成日期">
          <el-date-picker v-model="progressForm.done_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="progressForm.note" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="progressDialog = false">取消</el-button>
        <el-button type="primary" @click="submitProgress">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="undoDialog" :title="`撤销工序（已选 ${selected.length} 件）`" width="420px">
      <el-form label-width="80px">
        <el-form-item label="撤销工序">
          <el-radio-group v-model="undoStage">
            <el-radio-button value="milling">铣磨</el-radio-button>
            <el-radio-button value="cnc">CNC</el-radio-button>
            <el-radio-button value="grinding">精磨</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-alert type="warning" :closable="false" title="只用于纠正录错的记录；电镀和出货请分别在外发单/出货记录里撤销" />
      </el-form>
      <template #footer>
        <el-button @click="undoDialog = false">取消</el-button>
        <el-button type="danger" @click="submitUndo">撤销</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="outsourceDialog" :title="`${OUT_TITLES[outsourceForm.type]}（已选 ${selected.length} 件）`" width="480px">
      <el-form label-width="90px">
        <el-form-item label="外协厂家" required>
          <el-select v-model="outsourceForm.vendor_id" filterable style="width: 100%" placeholder="选择厂家">
            <el-option v-for="v in vendorOptions" :key="v.id" :label="v.name" :value="v.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发出日期">
          <el-date-picker v-model="outsourceForm.sent_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="预计回厂">
          <el-date-picker v-model="outsourceForm.expected_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="outsourceForm.note" type="textarea" :rows="2" placeholder="加工要求、注意事项等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="outsourceDialog = false">取消</el-button>
        <el-button type="primary" @click="submitOutsource">建外发单</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="shipDialog" :title="`出货（已选 ${selected.length} 件）`" width="440px">
      <el-form label-width="80px">
        <el-form-item label="出货日期">
          <el-date-picker v-model="shipForm.ship_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="shipForm.note" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="shipDialog = false">取消</el-button>
        <el-button type="success" @click="submitShip">确认出货</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft } from '@element-plus/icons-vue';
import { api, canSeePrice, canEntry, token, getUser } from '../api.js';
import { ORDER_STATUS, pieceStatus } from '../consts.js';

const route = useRoute();
const router = useRouter();
const showPrice = canSeePrice();
const entry = canEntry();
const tk = token();

const detail = ref(null);
const loading = ref(false);
const selected = ref([]);
const vendors = ref([]);
const today = new Date().toISOString().slice(0, 10);

const timelineDialog = ref(false);
const timelinePiece = ref(null);
const timelineEvents = ref([]);

const STAGE_LABELS = {
  milling: { label: '铣磨完成', type: 'success' },
  cnc: { label: 'CNC完成', type: 'success' },
  grinding: { label: '精磨完成', type: 'success' },
  plating_sent: { label: '电镀外发', type: 'warning' },
  plating_back: { label: '电镀回厂', type: 'success' },
  shipped: { label: '出货', type: 'primary' }
};
const STAGE_ORDER = ['milling', 'cnc', 'grinding', 'plating_sent', 'plating_back', 'shipped'];

function openTimeline(row) {
  timelinePiece.value = row;
  const events = [];
  const o = detail.value.order;
  events.push({ date: o.order_date, seq: -1, label: '订单创建', type: 'info', by: o.created_by_name, recorded_at: o.created_at, note: `订单 ${o.order_no}` });
  for (const [stage, info] of Object.entries(row.stages || {})) {
    const meta = STAGE_LABELS[stage];
    if (!meta) continue;
    events.push({
      date: info.done_date, seq: STAGE_ORDER.indexOf(stage),
      label: meta.label, type: meta.type,
      note: info.note, by: info.by, recorded_at: info.recorded_at
    });
  }
  for (const os of row.outsourcing || []) {
    if (os.type === 'cnc' || os.type === 'grinding') {
      events.push({
        date: os.sent_date, seq: os.type === 'cnc' ? 1.5 : 2.5,
        label: `${os.type === 'cnc' ? 'CNC加工' : '精磨'}外发 → ${os.vendor_name}（${os.batch_no}）`, type: 'warning',
        note: [os.note, os.expected_date ? `预计回厂 ${os.expected_date}` : ''].filter(Boolean).join('；')
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  timelineEvents.value = events;
  timelineDialog.value = true;
}

const progressDialog = ref(false);
const progressForm = ref({ stage: 'milling', done_date: today, note: '' });
const startDialog = ref(false);
const startForm = ref({ stage: 'milling', start_date: today, note: '' });

const selectedHasWip = computed(() => selected.value.some(s => s.wip_stage));

function openStart() {
  startForm.value = { stage: 'milling', start_date: today, note: '' };
  startDialog.value = true;
}

async function submitStart() {
  await api.post('/progress/start', { piece_ids: ids(), ...startForm.value });
  ElMessage.success('已标记开工');
  startDialog.value = false;
  load();
}

async function clearWip() {
  await api.post('/progress/clear-wip', { piece_ids: ids() });
  ElMessage.success('已清除开工标记');
  startDialog.value = false;
  load();
}
const undoDialog = ref(false);
const undoStage = ref('milling');
const OUT_TITLES = { cnc: 'CNC外发', grinding: '精磨外发', plating: '电镀外发' };
const outsourceDialog = ref(false);
const outsourceForm = ref({ type: 'cnc', vendor_id: null, sent_date: today, expected_date: null, note: '' });
const shipDialog = ref(false);
const shipForm = ref({ ship_date: today, note: '' });

const canHardDelete = ['admin', 'cnc_manager'].includes(getUser()?.role);
const isAdmin = getUser()?.role === 'admin';

async function deleteClosedOrder() {
  const { value: password } = await ElMessageBox.prompt(
    `即将彻底删除已结案订单 ${detail.value.order.order_no}（含明细、板件履历、出货记录、图纸附件），不可恢复。\n请输入你的登录密码进行授权确认：`,
    '总经理授权删除',
    { type: 'error', inputType: 'password', inputPlaceholder: '登录密码', confirmButtonText: '授权并删除', confirmButtonClass: 'el-button--danger' }
  );
  await api.delete(`/orders/${detail.value.order.id}`, { data: { password } });
  ElMessage.success('订单已删除');
  router.push('/orders');
}

const voidDaysLeft = computed(() => {
  const va = detail.value?.order.voided_at;
  if (!va) return 15;
  const elapsed = (Date.now() - new Date(va.replace(' ', 'T')).getTime()) / 86400_000;
  return Math.max(0, Math.ceil(15 - elapsed));
});

async function hardDelete() {
  await ElMessageBox.confirm(
    `彻底删除订单 ${detail.value.order.order_no}？明细、板件记录、图纸附件将一并删除，不可恢复。`,
    '确认彻底删除', { type: 'error', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
  );
  await api.delete(`/orders/${detail.value.order.id}`);
  ElMessage.success('订单已彻底删除');
  router.push('/orders');
}

const allPieces = computed(() => detail.value ? detail.value.items.flatMap(i => i.pieces) : []);
const shippedCount = computed(() => allPieces.value.filter(p => p.stages.shipped).length);

const pieceRows = computed(() => {
  if (!detail.value) return [];
  const rows = [];
  for (const it of detail.value.items) {
    for (const p of it.pieces) {
      const openOuts = (p.outsourcing || []).filter(o => !o.returned_date && (o.status === 'open' || o.status === 'draft'));
      rows.push({
        ...p,
        part_no: it.part_no, drawing_no: it.drawing_no, item_name: it.name,
        spec: it.spec, material: it.material,
        cncOut: openOuts.find(o => o.type === 'cnc') || null,
        grindOut: openOuts.find(o => o.type === 'grinding') || null,
        platingOut: openOuts.find(o => o.type === 'plating') || null,
        statusTag: pieceStatus(p)
      });
    }
  }
  return rows;
});

const vendorOptions = computed(() =>
  vendors.value.filter(v => {
    if (!v.active) return false;
    const types = String(v.type).split(',');
    return types.includes(outsourceForm.value.type) || types.includes('other');
  })
);

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get(`/orders/${route.params.id}`);
    detail.value = data;
  } finally { loading.value = false; }
}

function ids() { return selected.value.map(s => s.id); }

function openProgress() { progressForm.value = { stage: 'milling', done_date: today, note: '' }; progressDialog.value = true; }
function openUndo() { undoDialog.value = true; }
function openOutsource(type) {
  outsourceForm.value = { type, vendor_id: null, sent_date: today, expected_date: null, note: '' };
  outsourceDialog.value = true;
}
function openShip() {
  const bad = selected.value.find(s => s.stages.shipped || s.cncOut || s.platingOut);
  if (bad) return ElMessage.warning(`${bad.piece_code} 已出货或还在外发中，不能出货`);
  shipForm.value = { ship_date: today, note: '' };
  shipDialog.value = true;
}

async function submitProgress() {
  await api.post('/progress', { piece_ids: ids(), ...progressForm.value });
  ElMessage.success('报工成功');
  progressDialog.value = false;
  load();
}

async function submitUndo() {
  await api.post('/progress/undo', { piece_ids: ids(), stage: undoStage.value });
  ElMessage.success('已撤销');
  undoDialog.value = false;
  load();
}

async function submitOutsource() {
  if (!outsourceForm.value.vendor_id) return ElMessage.warning('请选择外协厂家');
  const { data } = await api.post('/outsourcing', { piece_ids: ids(), ...outsourceForm.value });
  ElMessage({ message: `外发单 ${data.batch_no} 已生成（待确认）。货实际发出后，请在打印页点「确认已外发」，板件才算在外。`, type: 'warning', duration: 6000 });
  outsourceDialog.value = false;
  await load();
  window.open(router.resolve(`/print/outsourcing/${data.id}`).href, '_blank');
}

async function submitShip() {
  const { data } = await api.post('/shipments', { order_id: detail.value.order.id, piece_ids: ids(), ...shipForm.value });
  ElMessage.success(`送货单 ${data.ship_no} 已创建${data.closed ? '，订单已全部出货并自动结案' : ''}`);
  shipDialog.value = false;
  await load();
  openPrint(data.id);
}

function openPrint(shipmentId) {
  const url = router.resolve(`/print/shipment/${shipmentId}`).href;
  window.open(url, '_blank');
}

async function delShipment(row) {
  await ElMessageBox.confirm(`撤销送货单 ${row.ship_no}？其中的板件会退回"未出货"状态。`, '确认撤销', { type: 'warning' });
  await api.delete(`/shipments/${row.id}`);
  ElMessage.success('已撤销');
  load();
}

async function delAttachment(row) {
  await ElMessageBox.confirm(`删除附件「${row.orig_name}」？`, '确认删除', { type: 'warning' });
  await api.delete(`/attachments/${row.id}`);
  load();
}

function uploadError(err) {
  let msg = '上传失败';
  try { msg = JSON.parse(err.message).error || msg; } catch {}
  ElMessage.error(msg);
}

async function setStatus(status) {
  const tips = { closed: '确认手动结案这张订单？', active: '重新打开这张订单？', void: '作废后订单不再参与统计，确认作废？' };
  await ElMessageBox.confirm(tips[status], '确认操作', { type: 'warning' });
  await api.post(`/orders/${detail.value.order.id}/status`, { status });
  ElMessage.success('已更新');
  load();
}

onMounted(async () => {
  load();
  const { data } = await api.get('/vendors');
  vendors.value = data.vendors;
});
</script>

<style scoped>
.done { color: #67c23a; font-size: 12px; }
.pending { color: #dcdfe6; }
</style>
