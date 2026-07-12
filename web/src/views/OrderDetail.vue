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
        <el-descriptions-item label="总件数">{{ piecesTotal }} 件</el-descriptions-item>
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
            <el-button size="small" :disabled="!selected.length" @click="openOutsource('work')">加工外发</el-button>
            <el-button size="small" :disabled="!selected.length" @click="openOutsource('plating')">电镀外发</el-button>
            <el-button size="small" type="success" :disabled="!selected.length" @click="openShip">出货</el-button>
            <el-button size="small" color="#7b52c7" plain :disabled="!selected.length" @click="openFlag">特殊状态</el-button>
            <el-button size="small" type="danger" plain :disabled="!selected.length" @click="openUndo">撤销工序</el-button>
          </template>
        </div>
      </template>

      <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
        <el-input v-model="pieceQuery" placeholder="在本订单内筛板件：板件号/编号/图号/品名/规格/材质/备注" clearable style="width: 360px" />
        <el-select v-model="pieceFilter" placeholder="全部状态" clearable style="width: 140px">
          <el-option v-for="s in ['待铣磨','待CNC','待精磨','待电镀','待出货','加工中','外发中','特殊状态','已出货']" :key="s" :label="s" :value="s" />
        </el-select>
        <span v-if="pieceQuery || pieceFilter" style="color:#909399; font-size:13px">
          筛出 {{ pieces.length }} / 共 {{ piecesTotal }} 件
        </span>
      </div>
      <el-table ref="pieceTable" :data="pieces" border size="small" @selection-change="s => selected = s" row-key="id" :row-class-name="stallRowClass">
        <el-table-column type="selection" width="40" :selectable="() => entry && detail.order.status !== 'void'" reserve-selection />
        <el-table-column label="板件号" width="130" fixed>
          <template #default="{ row }">
            <a href="javascript:;" style="color:#409eff; text-decoration:none" @click.stop="openTimeline(row)">{{ row.piece_code }}</a>
          </template>
        </el-table-column>
        <el-table-column prop="part_no" label="编号" width="90" show-overflow-tooltip />
        <el-table-column prop="drawing_no" label="图号" width="110" show-overflow-tooltip />
        <el-table-column prop="item_name" label="品名" width="100" show-overflow-tooltip />
        <el-table-column prop="spec" label="规格" width="120" show-overflow-tooltip />
        <el-table-column prop="material" label="材质" width="70" show-overflow-tooltip />
        <el-table-column v-for="proc in ['milling', 'cnc', 'grinding']" :key="proc"
          :label="{ milling: '铣磨', cnc: 'CNC', grinding: '精磨' }[proc]" width="96" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.outNow && String(row.outNow.type).split(',').includes(proc)"
              :content="`外发单 ${row.outNow.batch_no}：${row.outNow.vendor_name}${row.outNow.note ? '（' + row.outNow.note + '）' : ''}`">
              <el-tag type="warning" size="small" :effect="row.outNow.status === 'draft' ? 'plain' : 'light'">{{ row.outNow.status === 'draft' ? '待确认' : '外发中' }}</el-tag>
            </el-tooltip>
            <el-tooltip v-else-if="row.stages[proc]" :content="row.stages[proc].note || '本厂完成'">
              <span class="done">{{ row.stages[proc].done_date.slice(5) }}<sup v-if="row.stages[proc].ext" class="ext">外</sup></span>
            </el-tooltip>
            <span v-else class="pending">—</span>
          </template>
        </el-table-column>
        <el-table-column label="电镀" width="106" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.outNow && String(row.outNow.type).includes('plating')" :content="`外发单 ${row.outNow.batch_no}：${row.outNow.vendor_name}`">
              <el-tag type="warning" size="small" :effect="row.outNow.status === 'draft' ? 'plain' : 'light'">{{ row.outNow.status === 'draft' ? '待确认' : '电镀中' }}</el-tag>
            </el-tooltip>
            <el-tooltip v-else-if="row.stages.plating_back" :content="row.stages.plating_back.note || ''">
              <span class="done">回 {{ row.stages.plating_back.done_date.slice(5) }}</span>
            </el-tooltip>
            <span v-else class="pending">—</span>
          </template>
        </el-table-column>
        <el-table-column label="出货" width="96" align="center">
          <template #default="{ row }">
            <el-tooltip v-if="row.stages.shipped" :content="row.stages.shipped.note || ''">
              <span class="done">{{ row.stages.shipped.done_date.slice(5) }}</span>
            </el-tooltip>
            <span v-else class="pending">—</span>
          </template>
        </el-table-column>
        <el-table-column label="当前状态" min-width="150">
          <template #default="{ row }">
            <el-tooltip v-if="row.statusTag.special" :content="`${row.flag_date || ''} 标记${row.flag_note ? '：' + row.flag_note : ''}`">
              <el-tag size="small" class="tag-special">{{ row.statusTag.label }}</el-tag>
            </el-tooltip>
            <el-tooltip v-else-if="row.statusTag.wip" :content="`开工日期 ${row.wip_date}${row.wip_note ? '，' + row.wip_note : ''}`">
              <el-tag :type="row.statusTag.type" size="small" effect="dark">{{ row.statusTag.label }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="row.statusTag.type" size="small">{{ row.statusTag.label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="滞留" width="72" align="center">
          <template #default="{ row }">
            <span v-if="row.stages.shipped" class="pending">—</span>
            <b v-else-if="row.stall_level === 'alert'" style="color:#f56c6c">{{ row.idle_days }}天</b>
            <b v-else-if="row.stall_level === 'warn'" style="color:#e6a23c">{{ row.idle_days }}天</b>
            <span v-else style="color:#909399">{{ row.idle_days }}天</span>
          </template>
        </el-table-column>
        <el-table-column label="行备注" min-width="110" show-overflow-tooltip>
          <template #default="{ row }"><span style="color:#606266">{{ row.item_remark || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="件备注" min-width="110">
          <template #default="{ row }">
            <span style="color:#606266">{{ row.note || '' }}</span>
            <el-button v-if="entry" text size="small" style="padding: 2px 4px" @click.stop="editNote(row)">
              {{ row.note ? '改' : '+备注' }}
            </el-button>
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
              <el-tag size="small" :type="drawingDone === detail.items.length ? 'success' : 'danger'" style="margin-left: 8px">
                图纸 {{ drawingDone }}/{{ detail.items.length }}
              </el-tag>
              <div style="flex: 1"></div>
              <el-upload v-if="entry" :action="`/api/orders/${detail.order.id}/attachments`" :headers="{ Authorization: 'Bearer ' + tk }"
                name="files" multiple :show-file-list="false" :on-success="load" :on-error="uploadError">
                <el-button size="small" plain>上传订单附件</el-button>
              </el-upload>
            </div>
          </template>

          <div v-for="it in detail.items" :key="it.id" class="draw-row">
            <div class="draw-head">
              <span class="draw-line">#{{ it.line_no }}</span>
              <b>{{ it.drawing_no || it.name || '（无图号）' }}</b>
              <span v-if="it.drawing_no && it.name" class="draw-name">{{ it.name }}</span>
              <el-tag v-if="(attachByItem[it.id] || []).length" type="success" size="small" effect="plain">
                已传 {{ attachByItem[it.id].length }} 个
              </el-tag>
              <el-tag v-else type="danger" size="small">未传图纸</el-tag>
              <div style="flex: 1"></div>
              <el-upload v-if="entry" :action="`/api/orders/${detail.order.id}/attachments`" :headers="{ Authorization: 'Bearer ' + tk }"
                :data="{ item_id: it.id }" name="files" multiple :show-file-list="false" :on-success="load" :on-error="uploadError">
                <el-button text type="primary" size="small">传图纸</el-button>
              </el-upload>
            </div>
            <div v-for="a in attachByItem[it.id] || []" :key="a.id" class="draw-file">
              <a :href="`/api/attachments/${a.id}/download?token=${tk}`" target="_blank">{{ a.orig_name }}</a>
              <span class="draw-meta">{{ (a.size / 1024 / 1024).toFixed(2) }} MB · {{ a.uploaded_by_name }}</span>
              <el-button v-if="entry" text type="danger" size="small" @click="delAttachment(a)">删</el-button>
            </div>
          </div>

          <template v-if="orderAttachments.length">
            <el-divider content-position="left" style="margin: 10px 0 6px">
              <span style="font-size: 12px; color: #909399">订单附件（不属于某个图号，如客户PO留档）</span>
            </el-divider>
            <div v-for="a in orderAttachments" :key="a.id" class="draw-file">
              <a :href="`/api/attachments/${a.id}/download?token=${tk}`" target="_blank">{{ a.orig_name }}</a>
              <span class="draw-meta">{{ (a.size / 1024 / 1024).toFixed(2) }} MB · {{ a.uploaded_by_name }}</span>
              <el-select v-if="entry" placeholder="归到图号" size="small" style="width: 150px"
                :model-value="null" @change="v => assignAttachment(a, v)">
                <el-option v-for="it in detail.items" :key="it.id" :value="it.id"
                  :label="`#${it.line_no} ${it.drawing_no || it.name || ''}`" />
              </el-select>
              <el-button v-if="entry" text type="danger" size="small" @click="delAttachment(a)">删</el-button>
            </div>
          </template>
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

    <el-dialog v-model="outsourceDialog" :title="`${outsourceForm.kind === 'plating' ? '电镀外发' : '加工外发'}（已选 ${selected.length} 件）`" width="500px">
      <el-form label-width="90px">
        <el-form-item v-if="outsourceForm.kind === 'work'" label="外发工序" required>
          <el-checkbox-group v-model="outsourceForm.procs">
            <el-checkbox value="milling">铣磨</el-checkbox>
            <el-checkbox value="cnc">CNC</el-checkbox>
            <el-checkbox value="grinding">精磨</el-checkbox>
          </el-checkbox-group>
          <div style="color:#909399; font-size:12px; width:100%">同一家厂连做几道就勾几道（须相邻，如CNC+精磨）；回货时勾选的工序都会自动标完成</div>
        </el-form-item>
        <el-form-item label="外协厂家" required>
          <el-select v-model="outsourceForm.vendor_id" filterable style="width: 100%" placeholder="选择厂家">
            <el-option v-for="v in vendorOptions" :key="v.id" :label="v.name" :value="v.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发出日期">
          <el-date-picker v-model="outsourceForm.sent_date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="预计回厂" required>
          <el-date-picker v-model="outsourceForm.expected_date" type="date" value-format="YYYY-MM-DD" style="width: 100%"
            placeholder="跟厂家约的回厂日子，看板按它提醒超期" />
        </el-form-item>
        <el-form-item label="加工要求">
          <el-input v-model="outsourceForm.requirements" type="textarea" :rows="3"
            :placeholder="outsourceForm.kind === 'plating' ? '如镀层厚度8μm/10μm，按本单实际要求改' : '打印在外发单红字要求区'" />
          <div style="color:#909399; font-size:12px">已按{{ outsourceForm.kind === 'plating' ? '电镀' : '加工' }}模板预填（系统设置里可改模板），本单不同就直接改这里，打印在外发单红字区</div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="outsourceForm.note" type="textarea" :rows="2" placeholder="其他注意事项" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="outsourceDialog = false">取消</el-button>
        <el-button type="primary" @click="submitOutsource">建外发单</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="flagDialog" :title="`特殊状态（已选 ${selected.length} 件）`" width="480px">
      <el-form label-width="90px">
        <el-form-item label="状态">
          <el-radio-group v-model="flagForm.flag">
            <el-radio-button value="repair">维修</el-radio-button>
            <el-radio-button value="rework">返工</el-radio-button>
            <el-radio-button value="redraw">改图</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="flagForm.note" placeholder="如：客户改孔位，等新图 / 边缘崩角返工" />
        </el-form-item>
        <el-alert type="info" :closable="false" title="标记期间该板禁止出货。要退工序（如返工重铣），用「撤销工序」逆序撤。处理完点下面「解除标记」恢复正常。" />
      </el-form>
      <template #footer>
        <el-button v-if="selectedHasFlag" type="success" plain @click="submitFlag(null)">解除标记（恢复正常）</el-button>
        <el-button @click="flagDialog = false">取消</el-button>
        <el-button color="#7b52c7" style="color:#fff" @click="submitFlag(flagForm.flag)">打上标记</el-button>
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
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft } from '@element-plus/icons-vue';
import { api, canSeePrice, canEntry, token, getUser } from '../api.js';
import { ORDER_STATUS, outTypeLabel, PIECE_FLAGS } from '../consts.js';

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
    if (!String(os.type).includes('plating')) {
      events.push({
        date: os.sent_date, seq: 2.5,
        label: `${outTypeLabel(os.type)}外发 → ${os.vendor_name}（${os.batch_no}）`, type: 'warning',
        note: [os.note, os.expected_date ? `预计回厂 ${os.expected_date}` : ''].filter(Boolean).join('；')
      });
    }
  }
  if (row.flag) {
    events.push({
      date: row.flag_date || o.order_date, seq: 99,
      label: `⚠ 特殊状态：${PIECE_FLAGS[row.flag] || row.flag}`, type: 'danger',
      note: row.flag_note
    });
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
const outsourceDialog = ref(false);
const outsourceForm = ref({ kind: 'work', procs: [], vendor_id: null, sent_date: today, expected_date: null, requirements: '', note: '' });
let reqTemplates = null; // 加工要求模板缓存（来自系统设置）
const flagDialog = ref(false);
const flagForm = ref({ flag: 'rework', note: '' });
const selectedHasFlag = computed(() => selected.value.some(s => s.flag));
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

// 板件行全部由后端算好（状态/筛选/滞留分级），前端只负责渲染
const pieces = ref([]);
const piecesTotal = ref(0);
const shippedCount = ref(0);

const pieceQuery = ref('');
const pieceFilter = ref('');
const pieceTable = ref(null);

async function fetchPieces() {
  const params = {};
  if (pieceQuery.value.trim()) params.q = pieceQuery.value.trim();
  if (pieceFilter.value) params.status = pieceFilter.value;
  const { data } = await api.get(`/orders/${route.params.id}/pieces`, { params });
  pieces.value = data.pieces;
  piecesTotal.value = data.total;
  shippedCount.value = data.shipped_count;
  // 选中的行同步为刷新后的新对象，否则报工/标记后按钮状态（如"解除标记"）读到旧数据
  if (selected.value.length) {
    const prevIds = new Set(selected.value.map(s => s.id));
    const fresh = data.pieces.filter(p => prevIds.has(p.id));
    if (fresh.length === prevIds.size) {
      selected.value = fresh;
    } else {
      // 有选中行已不在当前列表（被筛掉/已出货），清空避免幽灵选中
      pieceTable.value?.clearSelection();
      selected.value = [];
    }
  }
}

let pieceTimer = null;
watch([pieceQuery, pieceFilter], () => {
  pieceTable.value?.clearSelection();
  clearTimeout(pieceTimer);
  pieceTimer = setTimeout(fetchPieces, 300);
});

function stallRowClass({ row }) {
  return row.stall_level === 'alert' ? 'stall-alert' : row.stall_level === 'warn' ? 'stall-warn' : '';
}

const vendorOptions = computed(() =>
  vendors.value.filter(v => {
    if (!v.active) return false;
    const types = String(v.type).split(',');
    if (types.includes('other')) return true;
    const procs = outsourceForm.value.kind === 'plating' ? ['plating'] : outsourceForm.value.procs;
    if (!procs.length) return false;
    return procs.every(p => types.includes(p));
  })
);

async function load() {
  loading.value = true;
  try {
    const [{ data }] = await Promise.all([api.get(`/orders/${route.params.id}`), fetchPieces()]);
    detail.value = data;
  } finally { loading.value = false; }
}

function ids() { return selected.value.map(s => s.id); }

function openProgress() { progressForm.value = { stage: 'milling', done_date: today, note: '' }; progressDialog.value = true; }
function openUndo() { undoDialog.value = true; }
async function openOutsource(kind) {
  if (!reqTemplates) {
    const { data: s } = await api.get('/settings');
    reqTemplates = { work: s.out_requirements || '', plating: s.out_requirements_plating || '' };
  }
  outsourceForm.value = {
    kind, procs: kind === 'work' ? ['cnc'] : [], vendor_id: null,
    sent_date: today, expected_date: null,
    requirements: kind === 'plating' ? reqTemplates.plating : reqTemplates.work,
    note: ''
  };
  outsourceDialog.value = true;
}

function openFlag() {
  flagForm.value = { flag: 'rework', note: '' };
  flagDialog.value = true;
}

async function submitFlag(flag) {
  await api.post('/pieces/flag', { piece_ids: ids(), flag, note: flagForm.value.note });
  ElMessage.success(flag ? `已标记为「${PIECE_FLAGS[flag]}」` : '已解除标记');
  flagDialog.value = false;
  load();
}

async function editNote(row) {
  const { value } = await ElMessageBox.prompt(`板件 ${row.piece_code} 的备注：`, '件备注', {
    inputValue: row.note || '', inputPlaceholder: '写点这块板的具体情况', confirmButtonText: '保存'
  });
  await api.post('/pieces/note', { piece_id: row.id, note: value });
  load();
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
  const f = outsourceForm.value;
  const order = ['milling', 'cnc', 'grinding'];
  const type = f.kind === 'plating' ? 'plating' : order.filter(p => f.procs.includes(p)).join(',');
  if (!type) return ElMessage.warning('请至少勾选一道外发工序');
  if (!f.vendor_id) return ElMessage.warning('请选择外协厂家');
  if (!f.expected_date) return ElMessage.warning('请填写预计回厂日期（看板按它提醒超期）');
  if (f.sent_date && f.expected_date < f.sent_date) return ElMessage.warning('预计回厂日期不能早于发出日期');
  const { data } = await api.post('/outsourcing', {
    piece_ids: ids(), type, vendor_id: f.vendor_id,
    sent_date: f.sent_date, expected_date: f.expected_date, requirements: f.requirements, note: f.note
  });
  ElMessage({ message: `外发单 ${data.batch_no} 已生成（待确认）。货实际发出后，请在打印页点「确认已外发」，板件才算在外。`, type: 'warning', duration: 6000 });
  outsourceDialog.value = false;
  await load();
  window.open(router.resolve(`/print/outsourcing/${data.id}/po`).href, '_blank');
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

const attachByItem = computed(() => {
  const m = {};
  if (!detail.value) return m;
  for (const a of detail.value.attachments) {
    if (a.item_id) (m[a.item_id] ||= []).push(a);
  }
  return m;
});

const orderAttachments = computed(() =>
  detail.value ? detail.value.attachments.filter(a => !a.item_id) : []
);

const drawingDone = computed(() =>
  detail.value ? detail.value.items.filter(it => (attachByItem.value[it.id] || []).length).length : 0
);

async function assignAttachment(a, itemId) {
  await api.put(`/attachments/${a.id}`, { item_id: itemId });
  ElMessage.success('已归到对应图号');
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
.ext { color: #e6a23c; font-weight: bold; margin-left: 2px; font-size: 10px; }
.tag-special { background: #f3eefc !important; border-color: #b39ddb !important; color: #6a3fb5 !important; }
:deep(.stall-warn) td { background: #fdf6e3 !important; }
:deep(.stall-alert) td { background: #fdeaea !important; }
.draw-row { padding: 6px 0; border-bottom: 1px dashed #ebeef5; }
.draw-row:last-of-type { border-bottom: none; }
.draw-head { display: flex; align-items: center; gap: 8px; }
.draw-line { color: #909399; font-size: 12px; width: 26px; }
.draw-name { color: #909399; font-size: 12px; }
.draw-file { display: flex; align-items: center; gap: 10px; padding: 3px 0 3px 34px; font-size: 13px; }
.draw-file a { color: #409eff; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.draw-meta { color: #909399; font-size: 12px; flex-shrink: 0; }
</style>
