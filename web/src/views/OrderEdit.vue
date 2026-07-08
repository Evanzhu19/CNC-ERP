<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div style="display: flex; align-items: center;">
        <el-button style="margin-right: 12px" @click="goBack">
          <el-icon style="margin-right: 4px"><ArrowLeft /></el-icon>{{ isEdit ? '返回订单详情' : '返回订单列表' }}
        </el-button>
        <span style="font-weight: bold">{{ isEdit ? `编辑订单 ${form.order_no || ''}` : '新建订单' }}</span>
      </div>
    </template>

    <el-form label-width="90px" style="max-width: 900px">
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="客户" required>
            <el-select v-model="form.customer_id" filterable placeholder="选择客户" style="width: 100%">
              <el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="客户PO号">
            <el-input v-model="form.customer_po" placeholder="客户采购单编号" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-button text type="primary" @click="custDialog = true" style="margin-top: 4px">+ 快速新增客户</el-button>
        </el-col>
      </el-row>
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="下单日期">
            <el-date-picker v-model="form.order_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="交期">
            <el-date-picker v-model="form.due_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="备注">
            <el-input v-model="form.remark" />
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <el-divider content-position="left">订单明细（每行按数量自动生成板件号）</el-divider>

    <el-table :data="form.items" border>
      <el-table-column type="index" label="行" width="46" />
      <el-table-column label="编号" min-width="100">
        <template #default="{ row }"><el-input v-model="row.part_no" placeholder="编号" /></template>
      </el-table-column>
      <el-table-column label="图号" min-width="150">
        <template #default="{ row }"><el-input v-model="row.drawing_no" placeholder="图号" /></template>
      </el-table-column>
      <el-table-column label="品名" min-width="140">
        <template #default="{ row }"><el-input v-model="row.name" placeholder="品名" /></template>
      </el-table-column>
      <el-table-column label="规格（长×宽×厚）" min-width="150">
        <template #default="{ row }"><el-input v-model="row.spec" placeholder="如 2000x1200x60" /></template>
      </el-table-column>
      <el-table-column label="材质" min-width="80">
        <template #default="{ row }"><el-input v-model="row.material" placeholder="材质" /></template>
      </el-table-column>
      <el-table-column label="数量" width="96">
        <template #default="{ row }"><el-input-number v-model="row.qty" :min="1" :max="500" controls-position="right" style="width: 100%" /></template>
      </el-table-column>
      <el-table-column v-if="showPrice" label="单价" width="104">
        <template #default="{ row }"><el-input-number v-model="row.unit_price" :min="0" :precision="2" :controls="false" placeholder="单价" style="width: 100%" /></template>
      </el-table-column>
      <el-table-column v-if="showPrice" label="金额" width="104" align="right">
        <template #default="{ row }">{{ row.unit_price != null && row.qty ? '¥' + (row.unit_price * row.qty).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—' }}</template>
      </el-table-column>
      <el-table-column label="备注" min-width="110">
        <template #default="{ row }"><el-input v-model="row.remark" /></template>
      </el-table-column>
      <el-table-column width="50" align="center">
        <template #default="{ $index }">
          <el-button text type="danger" @click="form.items.splice($index, 1)">删</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div style="margin-top: 10px; display: flex; align-items: center;">
      <el-button @click="addLine">+ 加一行</el-button>
      <div style="flex: 1"></div>
      <span v-if="showPrice" style="font-size: 16px; margin-right: 16px;">
        合计：<b style="color: #d4380d">¥{{ total.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</b>
      </span>
      <el-button @click="$router.back()">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存订单</el-button>
    </div>
  </el-card>

  <el-dialog v-model="pdfDialog" title="导入客户PDF采购单" width="900px" top="5vh">
    <div v-if="!pdfResult">
      <el-alert type="info" :closable="false" style="margin-bottom: 14px"
        title="支持绝大多数PDF采购单（含各类ERP软件导出的）。图片型PDF会自动转OCR识别（较慢，需1分钟左右）。先选好客户再上传，系统会记住这家客户的表格格式。" />
      <div style="display: flex; gap: 10px; align-items: center;">
        <el-select v-model="form.customer_id" filterable placeholder="先选客户（可选）" style="width: 220px">
          <el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <input ref="fileInput" type="file" accept=".pdf" style="display:none" @change="onPdfPicked" />
        <el-button type="primary" :loading="parsing" @click="$refs.fileInput.click()">
          {{ parsing ? '正在识别...' : '选择PDF文件' }}
        </el-button>
      </div>
    </div>
    <div v-else>
      <el-alert v-if="pdfResult.ocr" type="warning" :closable="false" style="margin-bottom: 10px"
        title="这份PDF是图片型，结果来自OCR识别，数字和编号可能有个别认错，请逐行核对后再填入。" />
      <div style="margin-bottom: 10px; color: #606266;">
        识别到 {{ pdfResult.rows.length }} 行明细。请核对每一列对应的字段（点表头下拉框修改），不需要的列选「忽略」。
        <span v-if="pdfResult.meta.customer_po">客户PO：<b>{{ pdfResult.meta.customer_po }}</b>　</span>
        <span v-if="pdfResult.meta.due_date">交期：<b>{{ pdfResult.meta.due_date }}</b></span>
      </div>
      <div style="overflow-x: auto;">
        <table class="pdf-preview">
          <thead>
            <tr>
              <th style="width: 36px"></th>
              <th v-for="(h, i) in pdfResult.headers" :key="i">
                <div class="orig-header">{{ h }}</div>
                <el-select v-model="colFields[i]" size="small" style="width: 110px">
                  <el-option v-for="opt in fieldOptions" :key="opt.value ?? 'null'" :label="opt.label" :value="opt.value" />
                </el-select>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, ri) in pdfResult.rows" :key="ri">
              <td><el-checkbox v-model="rowChecked[ri]" /></td>
              <td v-for="(cell, ci) in row" :key="ci" :class="{ ignored: !colFields[ci] }">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <template #footer>
      <el-button v-if="pdfResult" @click="pdfResult = null">重新上传</el-button>
      <el-button @click="pdfDialog = false">取消</el-button>
      <el-button v-if="pdfResult" type="primary" @click="applyPdf">填入订单（{{ checkedCount }} 行）</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="custDialog" title="快速新增客户" width="420px">
    <el-form label-width="70px">
      <el-form-item label="名称" required><el-input v-model="newCust.name" /></el-form-item>
      <el-form-item label="联系人"><el-input v-model="newCust.contact" /></el-form-item>
      <el-form-item label="电话"><el-input v-model="newCust.phone" /></el-form-item>
      <el-form-item label="地址"><el-input v-model="newCust.address" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="custDialog = false">取消</el-button>
      <el-button type="primary" @click="addCustomer">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Document, ArrowLeft } from '@element-plus/icons-vue';
import { api, canSeePrice } from '../api.js';

const route = useRoute();
const router = useRouter();
const isEdit = computed(() => !!route.params.id);
const showPrice = canSeePrice();

const customers = ref([]);
const loading = ref(false);
const saving = ref(false);
const custDialog = ref(false);
const newCust = ref({ name: '', contact: '', phone: '', address: '' });

const today = new Date().toISOString().slice(0, 10);
const form = ref({
  customer_id: null, customer_po: '', order_date: today, due_date: null, remark: '',
  items: [blankLine()]
});

function blankLine() {
  return { part_no: '', drawing_no: '', name: '', spec: '', material: '', qty: 1, unit_price: null, remark: '' };
}

function goBack() {
  if (isEdit.value) router.push(`/orders/${route.params.id}`);
  else router.push('/orders');
}

function addLine() {
  const last = form.value.items[form.value.items.length - 1];
  const line = blankLine();
  if (last) { line.material = last.material; line.name = last.name; }
  form.value.items.push(line);
}

const total = computed(() =>
  form.value.items.reduce((s, r) => s + (r.unit_price != null && r.qty ? r.unit_price * r.qty : 0), 0)
);

const pdfDialog = ref(false);
const parsing = ref(false);
const pdfResult = ref(null);
const colFields = ref([]);
const rowChecked = ref([]);

const fieldOptions = [
  { label: '忽略', value: null },
  { label: '编号', value: 'part_no' },
  { label: '图号', value: 'drawing_no' },
  { label: '品名', value: 'name' },
  { label: '规格', value: 'spec' },
  { label: '材质', value: 'material' },
  { label: '数量', value: 'qty' },
  ...(showPrice ? [{ label: '单价', value: 'unit_price' }] : []),
  { label: '备注', value: 'remark' }
];

const checkedCount = computed(() => rowChecked.value.filter(Boolean).length);

function openPdfImport() {
  pdfResult.value = null;
  pdfDialog.value = true;
}

async function onPdfPicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  parsing.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    if (form.value.customer_id) fd.append('customer_id', form.value.customer_id);
    const { data } = await api.post('/orders/parse-pdf', fd);
    pdfResult.value = data;
    colFields.value = [...data.guesses];
    rowChecked.value = data.rows.map(() => true);
  } catch { /* 拦截器已提示 */ } finally {
    parsing.value = false;
  }
}

function parseQty(v) {
  const m = String(v).replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function parsePrice(v) {
  const m = String(v).replace(/[¥￥$,\s]/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function applyPdf() {
  const fields = colFields.value;
  if (!fields.includes('qty')) return ElMessage.warning('请先指定哪一列是「数量」');
  const items = [];
  pdfResult.value.rows.forEach((row, ri) => {
    if (!rowChecked.value[ri]) return;
    const it = blankLine();
    fields.forEach((f, ci) => {
      if (!f || !row[ci]) return;
      if (f === 'qty') it.qty = parseQty(row[ci]) ?? it.qty;
      else if (f === 'unit_price') it.unit_price = parsePrice(row[ci]);
      else it[f] = row[ci];
    });
    if (it.qty && it.qty > 0) items.push(it);
  });
  if (!items.length) return ElMessage.warning('没有可导入的有效行（每行必须有数量）');

  const blank = form.value.items.length === 1 && !form.value.items[0].part_no && !form.value.items[0].drawing_no && !form.value.items[0].name;
  form.value.items = blank ? items : [...form.value.items, ...items];
  const meta = pdfResult.value.meta || {};
  if (meta.customer_po && !form.value.customer_po) form.value.customer_po = meta.customer_po;
  if (meta.due_date && !form.value.due_date) form.value.due_date = meta.due_date;
  if (meta.order_date) form.value.order_date = meta.order_date;

  if (form.value.customer_id) {
    try {
      await api.post('/pdf-mappings', {
        customer_id: form.value.customer_id,
        headers: pdfResult.value.headers,
        fields
      });
    } catch {}
  }
  pdfDialog.value = false;
  ElMessage.success(`已填入 ${items.length} 行，请核对后保存`);
}

async function addCustomer() {
  if (!newCust.value.name.trim()) return ElMessage.warning('客户名称不能为空');
  const { data } = await api.post('/customers', newCust.value);
  const { data: d2 } = await api.get('/customers');
  customers.value = d2.customers.filter(c => c.active);
  form.value.customer_id = data.id;
  custDialog.value = false;
  ElMessage.success('客户已添加');
}

async function save() {
  if (!form.value.customer_id) return ElMessage.warning('请选择客户');
  if (!form.value.items.length) return ElMessage.warning('至少要有一行明细');
  for (const it of form.value.items) {
    if (!it.qty || it.qty < 1) return ElMessage.warning('数量必须大于0');
  }
  saving.value = true;
  try {
    if (isEdit.value) {
      await api.put(`/orders/${route.params.id}`, form.value);
      ElMessage.success('订单已保存');
      router.push(`/orders/${route.params.id}`);
    } else {
      const { data } = await api.post('/orders', form.value);
      ElMessage.success(`订单 ${data.order_no} 已创建`);
      router.push(`/orders/${data.id}`);
    }
  } catch { /* 已提示 */ } finally { saving.value = false; }
}

onMounted(async () => {
  const { data } = await api.get('/customers');
  customers.value = data.customers.filter(c => c.active);
  if (isEdit.value) {
    loading.value = true;
    try {
      const { data: d } = await api.get(`/orders/${route.params.id}`);
      form.value = {
        order_no: d.order.order_no,
        customer_id: d.order.customer_id,
        customer_po: d.order.customer_po,
        order_date: d.order.order_date,
        due_date: d.order.due_date,
        remark: d.order.remark,
        items: d.items.map(it => ({
          id: it.id, part_no: it.part_no, drawing_no: it.drawing_no, name: it.name,
          spec: it.spec, material: it.material, qty: it.qty,
          unit_price: it.unit_price ?? null, remark: it.remark
        }))
      };
    } finally { loading.value = false; }
  }
});
</script>

<style scoped>
.pdf-preview { border-collapse: collapse; width: 100%; font-size: 13px; }
.pdf-preview th, .pdf-preview td { border: 1px solid #e4e7ed; padding: 4px 8px; text-align: left; white-space: nowrap; }
.pdf-preview th { background: #f5f7fa; vertical-align: top; }
.orig-header { font-weight: bold; margin-bottom: 4px; color: #303133; }
.pdf-preview td.ignored { color: #c0c4cc; }
</style>
