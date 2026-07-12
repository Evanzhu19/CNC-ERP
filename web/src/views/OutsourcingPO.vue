<template>
  <div class="print-page" v-if="data">
    <div class="no-print toolbar">
      <el-button type="primary" @click="print">打印外发单</el-button>
      <el-button @click="$router.replace(`/print/outsourcing/${$route.params.id}`)">切换：装车交接单</el-button>
      <template v-if="data.batch.status === 'draft' && entry">
        <el-button type="success" @click="confirmSend">✓ 确认已外发</el-button>
        <el-button type="danger" plain @click="cancelBatch">撤销此单</el-button>
      </template>
      <el-button @click="close">关闭</el-button>
    </div>
    <div class="no-print" style="max-width: 1080px; margin: 0 auto 14px;">
      <el-alert v-if="data.batch.status === 'draft'" type="warning" :closable="false"
        title="此单为「待确认」状态：板件已被占住但还不算在外。货实际发出后点「确认已外发」。单价/金额栏留空，按与厂家谈的价手写。" />
      <el-alert v-else type="success" :closable="false" title="此单已确认外发。单价/金额栏留空手写。" />
    </div>

    <div class="sheet">
      <div class="watermark" aria-hidden="true">
        <span v-for="n in 3" :key="n">{{ companyName }}</span>
      </div>
      <div class="head">
        <img v-if="hasLogo" :src="logoUrl" class="logo" />
        <h1>{{ companyName || '＿＿＿＿＿＿＿＿' }}</h1>
      </div>
      <h2>采 购 订 单</h2>

      <div class="meta">
        <div class="meta-l">
          <div>供应商名称：{{ data.batch.vendor_name }}</div>
          <div>联系人：{{ data.batch.vendor_contact || '' }}</div>
          <div>电话：{{ data.batch.vendor_phone || '' }}</div>
          <div>地址：{{ data.batch.vendor_address || '' }}</div>
        </div>
        <div class="meta-r">
          <div>下单日期：{{ cnDate(data.batch.sent_date) }}</div>
          <div>采购单号：{{ data.batch.batch_no }}</div>
          <div>联系人：{{ settings.out_contact_name }}</div>
          <div>电话：{{ settings.out_contact_phone }}</div>
        </div>
      </div>

      <table class="lines">
        <thead>
          <tr>
            <th style="width: 34px">序号</th>
            <th style="width: 90px">名称</th>
            <th>图号</th>
            <th>规格</th>
            <th style="width: 64px">材质</th>
            <th style="width: 40px">单位</th>
            <th style="width: 44px">数量</th>
            <th style="width: 62px">单价</th>
            <th style="width: 72px">金额</th>
            <th style="width: 170px">备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in groupedLines" :key="i">
            <td class="c">{{ i + 1 }}</td>
            <td class="c">{{ l.item_name || '' }}</td>
            <td class="c">{{ l.drawing_no || '' }}</td>
            <td class="c">{{ l.spec || '' }}</td>
            <td class="c">{{ l.material || '' }}</td>
            <td class="c">件</td>
            <td class="c">{{ l.qty }}</td>
            <td></td>
            <td></td>
            <td class="codes">{{ l.codes }}</td>
          </tr>
          <tr>
            <td class="c">{{ groupedLines.length + 1 }}</td>
            <td colspan="5"></td>
            <td class="c"><b>{{ totalQty }}</b></td>
            <td class="c"><b>合计</b></td>
            <td class="c">¥</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div class="req" v-if="reqText">
        备注：{{ reqText }}
      </div>
      <div class="req" v-if="data.batch.note">
        本单加工内容：{{ outTypeLabel(data.batch.type) }}。{{ data.batch.note }}
      </div>
      <div class="req" v-else>
        本单加工内容：{{ outTypeLabel(data.batch.type) }}
      </div>

      <table class="lines" style="border-top: none">
        <tbody>
          <tr>
            <td style="width: 90px" class="c">人民币大写</td>
            <td></td>
          </tr>
          <tr>
            <td class="c">备注</td>
            <td class="red"><b>交期：{{ data.batch.expected_date ? cnDate(data.batch.expected_date) : '' }}</b></td>
          </tr>
        </tbody>
      </table>

      <div class="terms">
        <p>1、交货地址：{{ settings.out_deliver_address }} ，{{ companyName }}</p>
        <p>2、运费承担：供方承担　　　　3、运输方式：公路运输、物流</p>
        <p>4、发票税率：13%增值税　☑是　□否</p>
        <p>5、风险承担：货物交付前一切风险均由供方承担</p>
        <p>6、货物验收：货物到货后，需方按验收标准对货物进行检测验收，如有问题或数量短缺问题，供方应在得到需方通知后根据需方要求时间派人到需方处理相关事宜，根据问题严重程度，需方可以采取拒绝接受或限期补货，货款折扣等方式处理，供方经催告不处理的，合同自动解除，需方有权向供方追索相应的损失。</p>
        <p>7、质量要求：供方提供产品的材质、尺寸、生产工艺、品质等，必须满足需方提出的书面要求。产品符合行业标准，以及供需双方签字确认后的样板要求，品质不在验收时，按标准检验，若有不良品比例超允收标准时，我司有权批退回。</p>
        <p>8、收到采购订单后供方需在24小时内确认回传，否则视为默认。</p>
      </div>

      <div class="sign">
        <span>供应商确认并回签（盖章）：</span>
        <span>需方：{{ companyName }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, token, canEntry } from '../api.js';
import { outTypeLabel } from '../consts.js';

const route = useRoute();
const data = ref(null);
const settings = ref({});
const companyName = ref('');
const hasLogo = ref(false);
const logoUrl = `/api/settings/logo?token=${token()}`;
const entry = canEntry();

function cnDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${y}年${m}月${day}日`;
}

const groupedLines = computed(() => {
  if (!data.value) return [];
  const map = new Map();
  for (const p of data.value.pieces) {
    const key = [p.part_no, p.drawing_no, p.item_name, p.spec, p.material].join('||');
    if (!map.has(key)) {
      map.set(key, { item_name: p.item_name, drawing_no: p.drawing_no, spec: p.spec, material: p.material, qty: 0, codeList: [] });
    }
    const g = map.get(key);
    g.qty++;
    g.codeList.push(p.piece_code);
  }
  return [...map.values()].map(g => ({ ...g, codes: g.codeList.join(' ') }));
});

const totalQty = computed(() => data.value ? data.value.pieces.length : 0);

// 加工要求：本单填的优先；老单没填的按类型回退到系统模板（电镀/加工各一套）
const reqText = computed(() => {
  if (!data.value) return '';
  if (data.value.batch.requirements) return data.value.batch.requirements;
  return String(data.value.batch.type).includes('plating')
    ? (settings.value.out_requirements_plating || '')
    : (settings.value.out_requirements || '');
});

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

let pageStyle = null;
onMounted(async () => {
  pageStyle = document.createElement('style');
  pageStyle.textContent = '@media print { @page { size: A4 landscape; margin: 8mm; } }';
  document.head.appendChild(pageStyle);
  const [{ data: d }, { data: s }] = await Promise.all([
    api.get(`/outsourcing/${route.params.id}`),
    api.get('/settings')
  ]);
  data.value = d;
  settings.value = s;
  companyName.value = s.company_name;
  hasLogo.value = s.has_logo;
});
onBeforeUnmount(() => { if (pageStyle) pageStyle.remove(); });
</script>

<style scoped>
.print-page { background: #eee; min-height: 100vh; padding: 20px; }
.toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; max-width: 1080px; margin-left: auto; margin-right: auto; }
.sheet { background: #fff; max-width: 1080px; margin: 0 auto; padding: 28px 36px; font-size: 13px; color: #000; position: relative; overflow: hidden; }
.watermark { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-around; align-items: center; pointer-events: none; }
.watermark span { transform: rotate(-22deg); font-size: 46px; font-weight: bold; letter-spacing: 8px; color: rgba(0, 0, 0, 0.06); white-space: nowrap; }
.head { display: flex; align-items: center; justify-content: center; gap: 14px; }
.logo { height: 44px; }
h1 { text-align: center; font-size: 26px; margin: 0; letter-spacing: 2px; }
h2 { text-align: center; font-size: 17px; letter-spacing: 8px; margin: 10px 0 14px; font-weight: normal; }
.meta { display: flex; justify-content: space-between; margin-bottom: 8px; line-height: 1.9; }
.meta-l { max-width: 55%; }
.meta-r { text-align: left; }
table.lines { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.lines th, table.lines td { border: 1px solid #000; padding: 5px 4px; word-break: break-all; }
table.lines th { font-weight: bold; }
.c { text-align: center; }
.codes { font-size: 10px; color: #333; }
.req { border: 1px solid #000; border-top: none; padding: 6px 8px; color: #d00; font-weight: bold; text-align: center; }
.red { color: #d00; }
.terms { margin: 10px 0 0; line-height: 1.9; font-size: 12.5px; }
.terms p { margin: 0 0 2px; }
.sign { display: flex; justify-content: space-between; margin-top: 36px; padding: 0 30px 0 10px; }
@media print {
  .no-print { display: none !important; }
  .print-page { background: #fff; padding: 0; }
  .sheet { max-width: none; padding: 6mm 8mm; font-size: 12px; }
}
</style>

