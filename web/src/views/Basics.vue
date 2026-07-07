<template>
  <el-card shadow="never">
    <el-tabs v-model="tab">
      <el-tab-pane label="客户" name="customers">
        <div class="toolbar">
          <el-button v-if="editable" type="primary" @click="openCust()">+ 新增客户</el-button>
        </div>
        <el-table :data="customers" size="default">
          <el-table-column prop="name" label="客户名称" min-width="160" />
          <el-table-column prop="contact" label="联系人" width="120" />
          <el-table-column prop="phone" label="电话" width="140" />
          <el-table-column prop="address" label="地址" min-width="200" show-overflow-tooltip />
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '正常' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="editable" width="80">
            <template #default="{ row }"><el-button text type="primary" @click="openCust(row)">编辑</el-button></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="外协厂家" name="vendors">
        <div class="toolbar">
          <el-button v-if="editable" type="primary" @click="openVendor()">+ 新增厂家</el-button>
        </div>
        <el-table :data="vendors" size="default">
          <el-table-column prop="name" label="厂家名称" min-width="160" />
          <el-table-column label="类型" width="200">
            <template #default="{ row }">
              <el-tag v-for="t in String(row.type).split(',')" :key="t" size="small" style="margin-right: 4px">{{ VENDOR_TYPES[t] || t }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="contact" label="联系人" width="120" />
          <el-table-column prop="phone" label="电话" width="140" />
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '正常' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="editable" width="80">
            <template #default="{ row }"><el-button text type="primary" @click="openVendor(row)">编辑</el-button></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane v-if="canSettings" label="系统设置" name="settings">
        <el-form label-width="110px" style="max-width: 560px; margin-top: 8px">
          <el-form-item label="本厂名称">
            <el-input v-model="settings.company_name" placeholder="打印在交接单/送货单抬头" />
          </el-form-item>
          <el-form-item label="公司LOGO">
            <div>
              <div v-if="settings.has_logo" style="margin-bottom: 10px">
                <img :src="logoUrl" style="max-height: 64px; max-width: 300px; border: 1px solid #eee; padding: 4px" />
              </div>
              <input ref="logoInput" type="file" accept="image/*" style="display:none" @change="onLogoPicked" />
              <el-button size="small" type="primary" plain @click="$refs.logoInput.click()">
                {{ settings.has_logo ? '更换LOGO' : '上传LOGO' }}
              </el-button>
              <el-button v-if="settings.has_logo" size="small" type="danger" plain @click="removeLogo">删除LOGO</el-button>
              <div style="color:#909399; font-size:12px; margin-top:6px">会显示在外发交接单和送货单的抬头上（建议横版图，PNG/JPG，3MB以内）</div>
            </div>
          </el-form-item>
          <el-form-item label="滞留提示">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
              <span>状态无变化满</span>
              <el-input-number v-model="settings.stall_warn_days" :min="1" :max="60" controls-position="right" style="width:100px" />
              <span>天黄色提示；满</span>
              <el-input-number v-model="settings.stall_alert_days" :min="1" :max="90" controls-position="right" style="width:100px" />
              <span>天红色报警（在外的板同样计算）</span>
            </div>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="saveSettings">保存设置</el-button>
          </el-form-item>
        </el-form>
      </el-tab-pane>
    </el-tabs>
  </el-card>

  <el-dialog v-model="custDialog" :title="custForm.id ? '编辑客户' : '新增客户'" width="440px">
    <el-form label-width="70px">
      <el-form-item label="名称" required><el-input v-model="custForm.name" /></el-form-item>
      <el-form-item label="联系人"><el-input v-model="custForm.contact" /></el-form-item>
      <el-form-item label="电话"><el-input v-model="custForm.phone" /></el-form-item>
      <el-form-item label="地址"><el-input v-model="custForm.address" /></el-form-item>
      <el-form-item v-if="custForm.id" label="状态"><el-switch v-model="custForm.active" active-text="正常" inactive-text="停用" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="custDialog = false">取消</el-button>
      <el-button type="primary" @click="saveCust">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="vendorDialog" :title="vendorForm.id ? '编辑厂家' : '新增厂家'" width="440px">
    <el-form label-width="70px">
      <el-form-item label="名称" required><el-input v-model="vendorForm.name" /></el-form-item>
      <el-form-item label="类型" required>
        <el-checkbox-group v-model="vendorForm.types">
          <el-checkbox value="milling">铣磨</el-checkbox>
          <el-checkbox value="cnc">CNC加工</el-checkbox>
          <el-checkbox value="grinding">磨床加工</el-checkbox>
          <el-checkbox value="plating">电镀</el-checkbox>
          <el-checkbox value="other">其他</el-checkbox>
        </el-checkbox-group>
        <div style="color:#909399; font-size:12px; width:100%">能干几样勾几样，外发开单时对应类型的厂家列表里都会出现</div>
      </el-form-item>
      <el-form-item label="联系人"><el-input v-model="vendorForm.contact" /></el-form-item>
      <el-form-item label="电话"><el-input v-model="vendorForm.phone" /></el-form-item>
      <el-form-item v-if="vendorForm.id" label="状态"><el-switch v-model="vendorForm.active" active-text="正常" inactive-text="停用" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="vendorDialog = false">取消</el-button>
      <el-button type="primary" @click="saveVendor">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, getUser, token } from '../api.js';
import { VENDOR_TYPES } from '../consts.js';

const tab = ref('customers');
const customers = ref([]);
const vendors = ref([]);
const user = getUser();
const editable = ['admin', 'cnc_manager', 'clerk', 'follower', 'finance'].includes(user?.role);

const custDialog = ref(false);
const custForm = ref({});
const vendorDialog = ref(false);
const vendorForm = ref({});

const canSettings = ['admin', 'cnc_manager'].includes(user?.role);
const settings = ref({ company_name: '', has_logo: false });
const logoVersion = ref(0);
const logoUrl = computed(() => `/api/settings/logo?token=${token()}&v=${logoVersion.value}`);

async function loadSettings() {
  const { data } = await api.get('/settings');
  settings.value = data;
}

async function saveSettings() {
  await api.put('/settings', {
    company_name: settings.value.company_name,
    stall_warn_days: settings.value.stall_warn_days,
    stall_alert_days: settings.value.stall_alert_days
  });
  ElMessage.success('设置已保存');
}

async function onLogoPicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  await api.post('/settings/logo', fd);
  ElMessage.success('LOGO已上传');
  logoVersion.value++;
  loadSettings();
}

async function removeLogo() {
  await ElMessageBox.confirm('删除LOGO？打印单据抬头将只显示公司名。', '确认', { type: 'warning' });
  await api.delete('/settings/logo');
  loadSettings();
}

async function load() {
  const [c, v] = await Promise.all([api.get('/customers'), api.get('/vendors')]);
  customers.value = c.data.customers;
  vendors.value = v.data.vendors;
}

function openCust(row) {
  custForm.value = row ? { ...row, active: !!row.active } : { name: '', contact: '', phone: '', address: '' };
  custDialog.value = true;
}

async function saveCust() {
  if (!custForm.value.name?.trim()) return ElMessage.warning('名称不能为空');
  if (custForm.value.id) await api.put(`/customers/${custForm.value.id}`, custForm.value);
  else await api.post('/customers', custForm.value);
  ElMessage.success('已保存');
  custDialog.value = false;
  load();
}

function openVendor(row) {
  vendorForm.value = row
    ? { ...row, active: !!row.active, types: String(row.type).split(',').filter(Boolean) }
    : { name: '', types: ['cnc'], contact: '', phone: '' };
  vendorDialog.value = true;
}

async function saveVendor() {
  if (!vendorForm.value.name?.trim()) return ElMessage.warning('名称不能为空');
  if (!vendorForm.value.types?.length) return ElMessage.warning('请至少选择一种类型');
  const payload = { ...vendorForm.value, type: vendorForm.value.types.join(',') };
  if (vendorForm.value.id) await api.put(`/vendors/${vendorForm.value.id}`, payload);
  else await api.post('/vendors', payload);
  ElMessage.success('已保存');
  vendorDialog.value = false;
  load();
}

onMounted(() => {
  load();
  if (canSettings) loadSettings();
});
</script>

<style scoped>
.toolbar { margin-bottom: 12px; }
</style>
