<template>
  <div class="print-page" v-if="data">
    <div class="no-print toolbar">
      <el-button type="primary" @click="print">打印</el-button>
      <template v-if="data.batch.status === 'draft' && entry">
        <el-button type="success" @click="confirmSend">✓ 确认已外发</el-button>
        <el-button type="danger" plain @click="cancelBatch">撤销此单</el-button>
      </template>
      <el-button @click="close">关闭</el-button>
    </div>
    <div class="no-print" style="max-width: 800px; margin: 0 auto 14px;">
      <el-alert v-if="data.batch.status === 'draft'" type="warning" :closable="false"
        title="此单为「待确认」状态：板件还不算在外（但已被这张单占住，不会被重复开单）。货实际装车发出后，点上面的「确认已外发」，板件才正式变为外发中。没发成就点「撤销此单」。" />
      <el-alert v-else type="success" :closable="false" title="此单已确认外发，板件为在外状态，回厂后到「外发管理」登记回货。" />
    </div>

    <div class="sheet">
      <div class="head">
        <img v-if="hasLogo" :src="logoUrl" class="logo" />
        <h1>{{ companyName || '＿＿＿＿＿＿＿＿' }}</h1>
      </div>
      <h2>外 发 加 工 交 接 单</h2>
      <div class="meta">
        <div>
          <div>外协厂家：{{ data.batch.vendor_name }}</div>
          <div v-if="data.batch.vendor_contact">联系人：{{ data.batch.vendor_contact }}<span v-if="data.batch.vendor_phone">　电话：{{ data.batch.vendor_phone }}</span></div>
          <div>加工内容：{{ { cnc: 'CNC加工', grinding: '精磨（磨床加工）', plating: '电镀（镀铬）' }[data.batch.type] || data.batch.type }}</div>
        </div>
        <div>
          <div>外发单号：{{ data.batch.batch_no }}</div>
          <div>发出日期：{{ data.batch.sent_date }}</div>
          <div v-if="data.batch.expected_date">预计回厂：{{ data.batch.expected_date }}</div>
        </div>
      </div>

      <table class="lines">
        <thead>
          <tr>
            <th style="width: 36px">序</th>
            <th>板件号</th>
            <th>编号</th>
            <th>图号</th>
            <th>品名</th>
            <th>规格</th>
            <th>材质</th>
            <th style="width: 70px">装车勾选</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in data.pieces" :key="p.piece_id">
            <td class="c">{{ i + 1 }}</td>
            <td>{{ p.piece_code }}</td>
            <td>{{ p.part_no || '' }}</td>
            <td>{{ p.drawing_no || '' }}</td>
            <td>{{ p.item_name || '' }}</td>
            <td>{{ p.spec || '' }}</td>
            <td>{{ p.material || '' }}</td>
            <td class="c">□</td>
          </tr>
          <tr class="total-row">
            <td :colspan="7" class="r"><b>开单件数：{{ data.pieces.length }} 件</b></td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div v-if="data.batch.note" class="note">加工要求：{{ data.batch.note }}</div>

      <div class="warn-box">
        实际装车件数：＿＿＿＿ 件（装几件写几件，与开单数不符时请当场注明未装板件号：＿＿＿＿＿＿＿＿＿＿＿＿）
      </div>

      <div class="sign">
        <span>发货人：＿＿＿＿＿＿＿</span>
        <span>承运/收货签字：＿＿＿＿＿＿＿</span>
        <span>日期时间：＿＿＿＿＿＿＿</span>
      </div>
      <p class="tip">板件以本单为交接依据，回厂及月底对账均以本单板件号核对，请妥善保存。</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, token, canEntry } from '../api.js';

const route = useRoute();
const data = ref(null);
const companyName = ref('');
const hasLogo = ref(false);
const logoUrl = `/api/settings/logo?token=${token()}`;
const entry = canEntry();

function print() { window.print(); }
function close() { window.close(); }

async function confirmSend() {
  await ElMessageBox.confirm('确认这批板已经实际发出（装车拉走）？确认后板件状态变为外发中。', '确认外发', { type: 'warning', confirmButtonText: '确认已外发' });
  await api.post(`/outsourcing/${route.params.id}/confirm`);
  ElMessage.success('已确认外发，板件现在是在外状态');
  const { data: d } = await api.get(`/outsourcing/${route.params.id}`);
  data.value = d;
}

async function cancelBatch() {
  await ElMessageBox.confirm(`撤销外发单 ${data.value.batch.batch_no}？板件恢复原状态，这张单作废。`, '确认撤销', { type: 'warning', confirmButtonText: '撤销' });
  await api.delete(`/outsourcing/${route.params.id}`);
  ElMessage.success('外发单已撤销');
  setTimeout(() => window.close(), 800);
}

onMounted(async () => {
  const [{ data: d }, { data: s }] = await Promise.all([
    api.get(`/outsourcing/${route.params.id}`),
    api.get('/settings')
  ]);
  data.value = d;
  companyName.value = s.company_name;
  hasLogo.value = s.has_logo;
});
</script>

<style scoped>
.print-page { background: #eee; min-height: 100vh; padding: 20px; }
.toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; max-width: 800px; margin-left: auto; margin-right: auto; }
.sheet { background: #fff; max-width: 800px; margin: 0 auto; padding: 32px 40px; font-size: 13px; color: #000; }
.head { display: flex; align-items: center; justify-content: center; gap: 14px; }
.logo { height: 44px; }
h1 { text-align: center; font-size: 22px; margin: 0; }
h2 { text-align: center; font-size: 16px; letter-spacing: 6px; margin: 8px 0 16px; }
.meta { display: flex; justify-content: space-between; margin-bottom: 12px; line-height: 1.8; }
table.lines { width: 100%; border-collapse: collapse; }
table.lines th, table.lines td { border: 1px solid #000; padding: 5px 6px; }
table.lines th { background: #f2f2f2; font-weight: normal; }
.c { text-align: center; }
.r { text-align: right; }
.note { margin-top: 10px; }
.warn-box { margin-top: 14px; border: 1.5px solid #000; padding: 8px 10px; font-weight: bold; }
.sign { display: flex; justify-content: space-between; margin-top: 32px; }
.tip { color: #555; font-size: 11px; margin-top: 20px; }
@media print {
  .no-print { display: none !important; }
  .print-page { background: #fff; padding: 0; }
  .sheet { max-width: none; padding: 10mm 8mm; }
}
</style>
