<template>
  <div v-if="data">
    <el-row :gutter="16">
      <el-col :span="6">
        <el-card shadow="never"><div class="stat"><div class="num">{{ data.active_orders }}</div><div class="label">进行中订单</div></div></el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never"><div class="stat"><div class="num">{{ wip }}</div><div class="label">在制板件（未出货）</div></div></el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat">
            <div class="num" :class="{ warn: cncOut.pieces > 0 }">{{ cncOut.pieces }}</div>
            <div class="label">加工外发在外（CNC/磨）<span v-if="cncOut.overdue_pieces" class="overdue">（{{ cncOut.overdue_pieces }} 件超预计日期）</span></div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat">
            <div class="num" :class="{ warn: platingOut.pieces > 0 }">{{ platingOut.pieces }}</div>
            <div class="label">电镀在外<span v-if="platingOut.overdue_pieces" class="overdue">（{{ platingOut.overdue_pieces }} 件超预计日期）</span></div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-top: 16px;">
      <template #header>进行中订单的工序完成情况（共 {{ data.stages.total_pieces || 0 }} 件）</template>
      <el-row :gutter="16">
        <el-col v-for="s in stageBars" :key="s.key" :span="4">
          <div class="bar-label">{{ s.name }}</div>
          <el-progress :percentage="pct(s.val)" :stroke-width="14" :format="() => `${s.val || 0}件`" />
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px;" v-if="data.stalled">
      <template #header>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-weight: bold;">⚠ 滞留监控：状态无变化 ≥{{ data.stall_warn_days }}天 <el-tag type="warning" size="small" effect="dark">提示</el-tag>，≥{{ data.stall_alert_days }}天 <el-tag type="danger" size="small" effect="dark">报警</el-tag>（含在外的板）</span>
          <el-tag v-if="data.flagged_pieces" size="small" class="tag-special">特殊状态 {{ data.flagged_pieces }} 件</el-tag>
          <div style="flex: 1"></div>
          <span style="color:#909399; font-size:12px">阈值在 客户与厂家→系统设置 里调</span>
        </div>
      </template>
      <el-table :data="data.stalled" size="small" @row-click="r => $router.push(`/orders/${r.order_id}`)" style="cursor:pointer"
        :row-class-name="({ row }) => row.level === 'alert' ? 'stall-alert' : 'stall-warn'">
        <el-table-column prop="piece_code" label="板件号" width="130" />
        <el-table-column prop="order_no" label="订单号" width="100" />
        <el-table-column prop="customer_name" label="客户" min-width="120" show-overflow-tooltip />
        <el-table-column prop="item_name" label="品名" width="110" show-overflow-tooltip />
        <el-table-column prop="drawing_no" label="图号" width="110" show-overflow-tooltip />
        <el-table-column prop="spec" label="规格" width="120" show-overflow-tooltip />
        <el-table-column prop="next_stage" label="卡在" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag :type="row.level === 'alert' ? 'danger' : 'warning'" size="small">{{ row.next_stage }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="days_idle" label="滞留" width="80" align="center">
          <template #default="{ row }">
            <b :style="{ color: row.level === 'alert' ? '#f56c6c' : '#e6a23c' }">{{ row.days_idle }} 天</b>
          </template>
        </el-table-column>
        <el-table-column prop="due_date" label="交期" width="105">
          <template #default="{ row }">
            <span :style="{ color: row.due_date && row.due_date < today ? '#f56c6c' : '' }">{{ row.due_date || '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!data.stalled.length" description="很好，没有滞留的板件" :image-size="50" />
    </el-card>

    <el-card shadow="never" style="margin-top: 16px;">
      <template #header>交期临近 / 已到期的订单（7天内）</template>
      <el-table :data="data.due_soon" @row-click="r => $router.push(`/orders/${r.id}`)" style="cursor:pointer">
        <el-table-column prop="order_no" label="订单号" width="120" />
        <el-table-column prop="customer_name" label="客户" />
        <el-table-column prop="due_date" label="交期" width="120">
          <template #default="{ row }">
            <span :style="{ color: row.due_date < today ? '#f56c6c' : '#e6a23c' }">{{ row.due_date }}</span>
          </template>
        </el-table-column>
        <el-table-column label="出货进度" width="160">
          <template #default="{ row }">{{ row.shipped }} / {{ row.total }} 件</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!data.due_soon.length" description="最近7天没有到期的订单" :image-size="60" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

const data = ref(null);
const today = new Date().toISOString().slice(0, 10);

async function load() {
  const { data: d } = await api.get('/dashboard');
  data.value = d;
}

const wip = computed(() => (data.value?.stages.total_pieces || 0) - (data.value?.stages.shipped || 0));
const cncOut = computed(() => data.value?.outsourcing_open.find(o => o.type === 'work') || { pieces: 0, overdue_pieces: 0 });
const platingOut = computed(() => data.value?.outsourcing_open.find(o => o.type === 'plating') || { pieces: 0, overdue_pieces: 0 });

const stageBars = computed(() => {
  const s = data.value?.stages || {};
  return [
    { key: 'milling', name: '铣磨完成', val: s.milling },
    { key: 'cnc', name: 'CNC完成', val: s.cnc },
    { key: 'grinding', name: '精磨完成', val: s.grinding },
    { key: 'plating_back', name: '电镀回厂', val: s.plating_back },
    { key: 'shipped', name: '已出货', val: s.shipped }
  ];
});

function pct(v) {
  const t = data.value?.stages.total_pieces || 0;
  return t ? Math.round(((v || 0) / t) * 100) : 0;
}

onMounted(load);
</script>

<style scoped>
.stat { text-align: center; padding: 8px 0; }
.num { font-size: 32px; font-weight: bold; color: #303133; }
.num.warn { color: #e6a23c; }
.label { color: #909399; margin-top: 4px; }
.overdue { color: #f56c6c; }
.bar-label { margin-bottom: 6px; color: #606266; }
.tag-special { background: #f3eefc !important; border-color: #b39ddb !important; color: #6a3fb5 !important; }
:deep(.stall-warn) td { background: #fdf6e3 !important; }
:deep(.stall-alert) td { background: #fdeaea !important; }
</style>
