<template>
  <div class="print-page" v-if="data">
    <div class="no-print toolbar">
      <el-checkbox v-if="allowPrice" v-model="withPrice" @change="load">打印单价金额</el-checkbox>
      <el-button type="primary" @click="print">打印</el-button>
      <el-button @click="close">关闭</el-button>
    </div>

    <div class="sheet">
      <div class="head">
        <img v-if="hasLogo" :src="logoUrl" class="logo" />
        <h1>{{ companyName || '＿＿＿＿＿＿＿＿' }}</h1>
      </div>
      <h2>送 货 单</h2>
      <div class="meta">
        <div>
          <div>客户：{{ data.shipment.customer_name }}</div>
          <div v-if="data.shipment.contact">联系人：{{ data.shipment.contact }}<span v-if="data.shipment.phone">　电话：{{ data.shipment.phone }}</span></div>
          <div v-if="data.shipment.address">地址：{{ data.shipment.address }}</div>
        </div>
        <div>
          <div>送货单号：{{ data.shipment.ship_no }}</div>
          <div>送货日期：{{ data.shipment.ship_date }}</div>
          <div>订单号：{{ data.shipment.order_no }}<span v-if="data.shipment.customer_po">　客户PO：{{ data.shipment.customer_po }}</span></div>
        </div>
      </div>

      <table class="lines">
        <thead>
          <tr>
            <th style="width: 36px">序</th>
            <th>编号</th>
            <th>图号</th>
            <th>品名</th>
            <th>规格</th>
            <th>材质</th>
            <th style="width: 50px">数量</th>
            <th v-if="data.with_price" style="width: 80px">单价</th>
            <th v-if="data.with_price" style="width: 90px">金额</th>
            <th>板件号</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in data.lines" :key="i">
            <td class="c">{{ i + 1 }}</td>
            <td>{{ l.part_no || '' }}</td>
            <td>{{ l.drawing_no || '' }}</td>
            <td>{{ l.name || '' }}</td>
            <td>{{ l.spec || '' }}</td>
            <td>{{ l.material || '' }}</td>
            <td class="c">{{ l.qty }}</td>
            <td v-if="data.with_price" class="r">{{ l.unit_price != null ? l.unit_price.toFixed(2) : '' }}</td>
            <td v-if="data.with_price" class="r">{{ l.amount != null ? l.amount.toFixed(2) : '' }}</td>
            <td class="codes">{{ l.piece_codes }}</td>
          </tr>
          <tr class="total-row">
            <td :colspan="6" class="r"><b>合计</b></td>
            <td class="c"><b>{{ totalQty }}</b></td>
            <td v-if="data.with_price"></td>
            <td v-if="data.with_price" class="r"><b>{{ totalAmount }}</b></td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div v-if="data.shipment.note" class="note">备注：{{ data.shipment.note }}</div>

      <div class="sign">
        <span>送货人：＿＿＿＿＿＿＿</span>
        <span>收货人签收：＿＿＿＿＿＿＿</span>
        <span>签收日期：＿＿＿＿＿＿＿</span>
      </div>
      <p class="tip">货物请当面点收，如有数量或外观问题请当天提出。</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api, canSeePrice, token } from '../api.js';

const route = useRoute();
const data = ref(null);
const allowPrice = canSeePrice();
const withPrice = ref(false);
const companyName = ref('');
const hasLogo = ref(false);
const logoUrl = `/api/settings/logo?token=${token()}`;

const totalQty = computed(() => data.value ? data.value.lines.reduce((s, l) => s + l.qty, 0) : 0);
const totalAmount = computed(() => {
  if (!data.value?.with_price) return '';
  return data.value.lines.reduce((s, l) => s + (l.amount || 0), 0).toFixed(2);
});

function print() { window.print(); }
function close() { window.close(); }

async function load() {
  const { data: d } = await api.get(`/shipments/${route.params.id}/print-data`, {
    params: withPrice.value ? { with_price: 1 } : {}
  });
  data.value = d;
}

onMounted(async () => {
  load();
  const { data: s } = await api.get('/settings');
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
h2 { text-align: center; font-size: 16px; letter-spacing: 8px; margin: 8px 0 16px; }
.meta { display: flex; justify-content: space-between; margin-bottom: 12px; line-height: 1.8; }
table.lines { width: 100%; border-collapse: collapse; }
table.lines th, table.lines td { border: 1px solid #000; padding: 5px 6px; }
table.lines th { background: #f2f2f2; font-weight: normal; }
.c { text-align: center; }
.r { text-align: right; }
.codes { font-size: 11px; }
.note { margin-top: 10px; }
.sign { display: flex; justify-content: space-between; margin-top: 36px; }
.tip { color: #555; font-size: 11px; margin-top: 24px; }
@media print {
  .no-print { display: none !important; }
  .print-page { background: #fff; padding: 0; }
  .sheet { max-width: none; padding: 10mm 8mm; }
}
</style>
