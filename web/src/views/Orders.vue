<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-select v-model="filters.status" style="width: 120px" @change="load">
        <el-option label="进行中" value="active" />
        <el-option label="已结案" value="closed" />
        <el-option label="已作废" value="void" />
        <el-option label="全部" value="" />
      </el-select>
      <el-select v-model="filters.customer_id" placeholder="全部客户" clearable filterable style="width: 180px" @change="load">
        <el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-date-picker v-model="filters.month" type="month" placeholder="下单月份" format="YYYY-MM" value-format="YYYY-MM" style="width: 140px" @change="load" />
      <el-input v-model="filters.q" placeholder="订单号/客户PO/编号/图号/规格/品名/板件号" style="width: 280px" clearable @keyup.enter="load" @clear="load" />
      <el-button @click="load">查询</el-button>
      <div style="flex: 1"></div>
      <el-button v-if="entry" type="warning" plain @click="openReconcile">PDF+台账 双证录入</el-button>
      <el-button v-if="entry" type="primary" @click="$router.push('/orders/new')">+ 新建订单</el-button>
    </div>

    <el-table :data="orders" v-loading="loading" @row-click="r => $router.push(`/orders/${r.id}`)" style="cursor: pointer">
      <el-table-column prop="order_no" label="订单号" width="110" />
      <el-table-column prop="customer_name" label="客户" min-width="140" show-overflow-tooltip />
      <el-table-column prop="customer_po" label="客户PO" width="130" show-overflow-tooltip />
      <el-table-column prop="order_date" label="下单日" width="105" />
      <el-table-column prop="due_date" label="交期" width="105">
        <template #default="{ row }">
          <span :style="{ color: row.status === 'active' && row.due_date && row.due_date < today ? '#f56c6c' : '' }">{{ row.due_date || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="进度（件）" min-width="220">
        <template #default="{ row }">
          <span class="prog">铣{{ row.milling || 0 }} · C{{ row.cnc || 0 }} · 磨{{ row.grinding || 0 }} · 镀回{{ row.plating_back || 0 }} · 出{{ row.shipped || 0 }} / {{ row.total || 0 }}</span>
          <el-tag v-if="row.wip_now" type="primary" size="small" style="margin-left: 6px">加工中{{ row.wip_now }}件</el-tag>
          <el-tag v-if="row.out_now" type="warning" size="small" style="margin-left: 4px">在外{{ row.out_now }}件</el-tag>
          <el-tag v-if="row.flagged_now" size="small" class="tag-special" style="margin-left: 4px">特殊{{ row.flagged_now }}件</el-tag>
          <el-tag v-if="row.status === 'active' && row.stall_alert_count" type="danger" size="small" effect="dark" style="margin-left: 4px">滞留{{ row.stall_alert_count }}件</el-tag>
          <el-tag v-else-if="row.status === 'active' && row.stall_warn_count" type="warning" size="small" effect="dark" style="margin-left: 4px">滞留{{ row.stall_warn_count }}件</el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="showPrice" label="金额" width="120" align="right">
        <template #default="{ row }">
          <span>{{ fmtMoney(row.amount) }}</span>
          <el-tooltip v-if="row.unpriced_lines" content="有明细行还没填单价"><span style="color:#e6a23c"> *</span></el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="ORDER_STATUS[row.status].type" size="small">{{ ORDER_STATUS[row.status].label }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !orders.length" description="没有符合条件的订单" />
  </el-card>

  <el-dialog v-model="reconcileDialog" title="PDF+台账 双证录入" width="720px" top="6vh">
    <el-alert type="info" :closable="false" style="margin-bottom: 14px"
      title="同时上传：客户PDF采购单 + Excel台账。系统按PO号定位台账订单，核对 PO/客户 是否同一张单、有没有重复录过。件数/图号的差异会分「PDF有台账没有（会少做，重点核）」和「台账有PDF没有（拆分件或记错单）」两个方向列出，每个图号可「查一下」它在系统里出现在哪些订单，帮你判断是正常拆分还是记错了PO。" />
    <div style="display:flex; gap:16px; margin-bottom:14px;">
      <div style="flex:1">
        <div style="margin-bottom:6px; color:#606266">① 客户PDF采购单</div>
        <input ref="pdfInput" type="file" accept=".pdf" style="display:none" @change="e => pickFile(e, 'pdf')" />
        <el-button style="width:100%" @click="$refs.pdfInput.click()">
          {{ recPdf ? '✓ ' + recPdf.name : '选择PDF文件' }}
        </el-button>
      </div>
      <div style="flex:1">
        <div style="margin-bottom:6px; color:#606266">② Excel台账</div>
        <input ref="xlsInput" type="file" accept=".xlsx,.xls" style="display:none" @change="e => pickFile(e, 'xls')" />
        <el-button style="width:100%" @click="$refs.xlsInput.click()">
          {{ recXls ? '✓ ' + recXls.name : '选择Excel台账' }}
        </el-button>
      </div>
      <div style="display:flex; align-items:flex-end">
        <el-button type="primary" :loading="reconciling" :disabled="!recPdf || !recXls" @click="doReconcile">开始核对</el-button>
      </div>
    </div>

    <div v-if="recError" style="margin-bottom:12px">
      <el-alert type="error" :closable="false" :title="recError" />
    </div>

    <div v-if="recResult">
      <!-- 顶部结论：三级 -->
      <el-alert v-if="!recResult.identity_ok" type="error" :closable="false" show-icon style="margin-bottom:10px"
        title="这两份文件对不上——PO号或客户不一致，不是同一张单，不能录入。请确认 PDF 和台账是同一张 PO。" />
      <el-alert v-else-if="recResult.duplicate" type="error" :closable="false" show-icon style="margin-bottom:10px"
        :title="`这张采购单 ${recResult.ledger.customer_po} 已经录过了（订单 ${recResult.duplicate}），不能重复录入。`" />
      <el-alert v-else-if="recResult.ledger_missing_drawing" type="error" :closable="false" show-icon style="margin-bottom:10px"
        title="台账里有明细行没填图号，请补上图号后再录入。" />
      <el-alert v-else-if="recResult.line_diff" type="warning" :closable="false" show-icon style="margin-bottom:10px"
        title="PO和客户对上了，但件数/图号与PDF有差异（见下方，按方向分列）。机架拆分的单两边组织方式不同属正常；重点看红色「客户PDF有、台账没有」——那是台账可能漏了、会导致少做。拿不准的图号点「查一下」看它在系统里的其它订单。" />
      <el-alert v-else type="success" :closable="false" show-icon style="margin-bottom:10px"
        title="✓ 完全一致，可以放心录入。" />

      <!-- 身份核对 -->
      <table class="rec-table">
        <thead><tr><th>核对项</th><th>PDF采购单</th><th>Excel台账</th><th style="width:80px">结果</th></tr></thead>
        <tbody>
          <tr v-for="c in recResult.id_checks" :key="c.key" :class="{ bad: !c.ok }">
            <td>{{ c.label }}</td>
            <td>{{ c.missing ? '（PDF没抽到）' : (c.pdf ?? '') }}</td>
            <td>{{ c.ledger ?? '' }}</td>
            <td>
              <span v-if="c.ok" style="color:#67c23a">✓ 一致</span>
              <span v-else style="color:#f56c6c">✗ {{ c.missing ? '缺字段' : '不符' }}</span>
            </td>
          </tr>
          <tr :class="{ bad: !recResult.qty_check.ok }">
            <td>总件数</td>
            <td>{{ recResult.qty_check.pdf ?? '（未识别）' }} 件</td>
            <td>{{ recResult.qty_check.ledger }} 件</td>
            <td>
              <span v-if="recResult.qty_check.ok" style="color:#67c23a">✓ 一致</span>
              <span v-else style="color:#e6a23c">差{{ Math.abs((recResult.qty_check.pdf||0) - recResult.qty_check.ledger) }}件</span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 差异明细：直接在客户采购单的行上「调整」，说清这一行实际是哪几个图号各几件 -->
      <div v-if="recResult.line_diff" style="margin-top:12px">
        <div class="diff-head danger">
          客户采购单上对不上的行 —— 逐行核对图纸后点「调整」，填清楚这一行实际是哪几个图号、各几件
        </div>
        <table class="rec-table">
          <thead>
            <tr>
              <th>客户采购单的图号 / 内容</th>
              <th style="width:66px">采购单</th>
              <th style="width:66px">台账</th>
              <th>核对结果</th>
              <th style="width:130px">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in poRows" :key="r.key">
              <tr :class="r.adj ? 'done' : 'bad'">
                <td>{{ r.label }}<span v-if="r.name" style="color:#909399">（{{ r.name }}）</span></td>
                <td>{{ r.qty }} 件</td>
                <td>{{ r.ledger_qty ? r.ledger_qty + ' 件' : '无' }}</td>
                <td>
                  <span v-if="!r.adj" style="color:#f56c6c">✗ 未交代，请调整</span>
                  <span v-else-if="r.adj.qty === r.qty" style="color:#67c23a">✓ 已调整，件数对上</span>
                  <span v-else style="color:#e6a23c">已调整，但件数 {{ r.qty }}→{{ r.adj.qty }} 不等</span>
                </td>
                <td>
                  <el-button size="small" :type="r.adj ? 'default' : 'primary'" @click="openAdjust(r)">{{ r.adj ? '改' : '调整' }}</el-button>
                  <el-button v-if="r.adj" size="small" text type="danger" @click="r.adj = null">撤销</el-button>
                  <el-button v-else-if="r.drawing_no" size="small" text type="primary" @click="openLookup(r.drawing_no)">查一下</el-button>
                </td>
              </tr>
              <tr v-if="r.adj" class="adj-detail">
                <td colspan="5">
                  实际拆成：<b>{{ r.adj.lines.map(l => l.drawing_no + ' ' + l.qty + '件').join('　+　') }}</b>
                  <span style="color:#909399">　—　{{ ADJ_REASONS[r.adj.reason] }}{{ r.adj.note ? '：' + r.adj.note : '' }}</span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <!-- 台账这边多出来的：被调整认领掉就变绿，剩下的说明可能是串单 -->
        <template v-if="ledgerRemain.length">
          <div class="diff-head warn" style="margin-top:14px">台账上有、客户采购单上没有的图号（被上面的调整认领后转绿）</div>
          <table class="rec-table">
            <thead><tr><th>台账图号</th><th style="width:80px">台账件数</th><th style="width:110px">已被认领</th><th>状态</th><th style="width:90px">核查</th></tr></thead>
            <tbody>
              <tr v-for="l in ledgerRemain" :key="l.drawing_no" :class="l.left === 0 ? 'done' : 'warn'">
                <td>{{ l.drawing_no }}<span v-if="l.name" style="color:#909399">（{{ l.name }}）</span></td>
                <td>{{ l.qty }} 件</td>
                <td>{{ l.qty - l.left }} 件</td>
                <td>
                  <span v-if="l.left === 0" style="color:#67c23a">✓ 已交代清楚</span>
                  <span v-else-if="l.left < 0" style="color:#f56c6c">调整里填多了 {{ -l.left }} 件</span>
                  <span v-else style="color:#e6a23c">还剩 {{ l.left }} 件没交代（拆分件请在上面调整里选它；本单不该有则是记错PO）</span>
                </td>
                <td><el-button size="small" text type="primary" @click="openLookup(l.drawing_no)">查一下</el-button></td>
              </tr>
            </tbody>
          </table>
        </template>

        <div v-if="poUnadjustedQty" class="adj-warn danger">
          ⚠ 还有 {{ poUnadjustedQty }} 件客户要的没交代去向 —— 这部分有<b>少做</b>的风险，请逐行点「调整」核实清楚。
        </div>
        <div v-else-if="ledgerLeftQty > 0" class="adj-warn warn">
          台账这边还剩 {{ ledgerLeftQty }} 件没被认领。是拆分件就在对应行的「调整」里把它选上；如果本单根本不该有，可能是记错了PO。
        </div>
        <div v-else-if="poUnbalanced.length" class="adj-warn warn">
          有 {{ poUnbalanced.length }} 行调整后件数与采购单不等。件数对不上就说明还有东西没交代清楚，请复核。
        </div>
        <div v-else class="adj-warn ok">✓ 差异全部交代清楚，件数对得上，可以录入。</div>
      </div>

      <div style="margin-top:10px; color:#909399; font-size:13px">
        台账对应订单：{{ recResult.ledger.customer_name }} / {{ recResult.ledger.lines.length }}行 / 交期{{ recResult.ledger.due_date || '—' }}。录入以台账为准（含图号、材质等内部信息），PDF自动留档为附件。
      </div>
    </div>

    <template #footer>
      <el-button @click="reconcileDialog = false">关闭</el-button>
      <!-- 身份对上、不重复 就能录：完全一致直接录；有差异需勾选确认 -->
      <template v-if="recResult && recResult.identity_ok && !recResult.duplicate && !recResult.ledger_missing_drawing">
        <el-checkbox v-if="recResult.line_diff" v-model="diffConfirmed" style="margin-right:12px">
          {{ poUnadjustedQty ? `还有${poUnadjustedQty}件客户单上的没交代，我确认台账没漏，照录`
             : poUnbalanced.length ? `有${poUnbalanced.length}行调整后件数与采购单不等，我确认无误，照录`
             : '我已逐行核对无误，确认录入' }}
        </el-checkbox>
        <el-button type="primary" :loading="importing" :disabled="recResult.line_diff && !diffConfirmed" @click="doReconcileImport">
          {{ recResult.line_diff ? '确认录入' : '核对通过，录入' }}
        </el-button>
      </template>
    </template>
  </el-dialog>

  <!-- 调整这一行：客户采购单的一行，实际是哪几个图号各几件 -->
  <el-dialog v-model="adjDialog" title="调整明细" width="640px" append-to-body>
    <template v-if="adjTarget">
      <div class="adj-src">
        客户采购单这一行：<b>{{ adjTarget.label }}</b> <b style="color:#409eff">{{ adjTarget.qty }} 件</b>
        <span v-if="adjTarget.name" style="color:#909399">（{{ adjTarget.name }}）</span>
      </div>
      <div class="adj-tip">
        对照图纸核实后，填清楚这 {{ adjTarget.qty }} 件实际是哪几个图号、各几件。
        例：客户把一对镜像件并成一个图号发过来，这里就填成两行各 {{ Math.floor(adjTarget.qty / 2) }} 件。
        图号可以从台账里选（括号里是台账还剩几件没被认领），也可以直接手输。
      </div>

      <table class="rec-table">
        <thead><tr><th>实际图号</th><th style="width:130px">件数</th><th style="width:56px"></th></tr></thead>
        <tbody>
          <tr v-for="(l, i) in adjLines" :key="i">
            <td>
              <el-select v-model="l.drawing_no" filterable allow-create default-first-option
                placeholder="选台账图号，或直接输入" size="small" style="width:100%">
                <el-option v-for="o in ledgerRemain" :key="o.drawing_no" :value="o.drawing_no"
                  :label="`${o.drawing_no}（台账剩${o.left}件）`" />
              </el-select>
            </td>
            <td><el-input-number v-model="l.qty" :min="1" :max="2000" size="small" controls-position="right" style="width:100%" /></td>
            <td><el-button size="small" text type="danger" :disabled="adjLines.length <= 1" @click="adjLines.splice(i, 1)">删</el-button></td>
          </tr>
        </tbody>
      </table>
      <el-button size="small" text type="primary" style="margin-top:6px" @click="adjLines.push({ drawing_no: '', qty: 1 })">+ 添加一行</el-button>

      <div class="adj-sum">
        合计 <b>{{ adjLinesQty }}</b> 件 / 采购单 <b>{{ adjTarget.qty }}</b> 件
        <b v-if="adjLinesQty === adjTarget.qty" style="color:#67c23a">　✓ 对上了</b>
        <b v-else style="color:#f56c6c">　✗ 差 {{ Math.abs(adjLinesQty - adjTarget.qty) }} 件</b>
      </div>

      <div style="display:flex; gap:8px; margin-top:12px">
        <el-select v-model="adjReason" size="small" style="width:240px">
          <el-option v-for="(lab, k) in ADJ_REASONS" :key="k" :value="k" :label="lab" />
        </el-select>
        <el-input v-model="adjNote" size="small" style="flex:1" maxlength="200"
          placeholder="备注（选填，如：两图互为镜面，规格加工要求一致）" />
      </div>
      <div v-if="adjLinesQty !== adjTarget.qty && adjReason !== 'qty_diff'" style="color:#f56c6c; font-size:12px; margin-top:8px">
        件数对不上就不能确认（否则等于有东西没交代）。确实是件数和客户单不一样，请把原因选成「件数不一致（已与客户确认）」。
      </div>
    </template>
    <template #footer>
      <el-button @click="adjDialog = false">取消</el-button>
      <el-button type="primary" :disabled="!canConfirmAdjust" @click="confirmAdjust">确认调整</el-button>
    </template>
  </el-dialog>

  <!-- 图号核查：这个图号在系统里出现在哪些订单 -->
  <el-dialog v-model="lookupDialog" :title="`图号核查：${lookupDno}`" width="640px" append-to-body>
    <div v-loading="lookupLoading">
      <el-alert v-if="lookupError" type="error" :closable="false" :title="lookupError" />
      <template v-else>
        <el-alert v-if="!lookupLoading && !lookupRows.length" type="info" :closable="false" show-icon
          title="系统里还没有这个图号的任何订单记录（首次出现的新件）。" style="margin-bottom:10px" />
        <template v-else-if="lookupRows.length">
          <div style="margin-bottom:8px; color:#606266; font-size:13px">这个图号在系统里出现在下面 {{ lookupRows.length }} 张订单：</div>
          <table class="rec-table">
            <thead><tr><th>订单号</th><th>客户PO</th><th>客户</th><th style="width:56px">数量</th><th style="width:70px">状态</th><th style="width:100px">下单日</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in lookupRows" :key="i">
                <td>{{ r.order_no }}</td>
                <td>{{ r.customer_po || '—' }}</td>
                <td>{{ r.customer_name || '—' }}</td>
                <td>{{ r.qty }}</td>
                <td>{{ statusText(r.status) }}</td>
                <td>{{ r.order_date || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <div style="margin-top:10px; color:#909399; font-size:12px">
          判断参考：只出现在同客户/同类历史单 → 多半是正常拆分件；若出现在和本单无关的其它PO里、而本单PDF又没有它 → 很可能记错了PO（串单），请回台账核对。
        </div>
      </template>
    </div>
    <template #footer><el-button @click="lookupDialog = false">关闭</el-button></template>
  </el-dialog>

  <el-dialog v-model="excelDialog" title="Excel台账批量导入" width="960px" top="4vh">
    <div v-if="!excelResult">
      <el-alert type="info" :closable="false" style="margin-bottom: 14px"
        title="支持你们的《客户交期明细表》格式：自动识别每个月份工作表、按「客户+客户单号」分成一张张订单。没见过的客户会自动建档，客户单号已存在的订单默认跳过（防重复导入）。" />
      <input ref="excelInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onExcelPicked" />
      <el-button type="primary" :loading="excelParsing" @click="$refs.excelInput.click()">
        {{ excelParsing ? '正在解析...' : '选择Excel文件' }}
      </el-button>
    </div>
    <div v-else>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span>选择月份工作表：</span>
        <el-select v-model="activeSheet" style="width: 200px" @change="onSheetChange">
          <el-option v-for="s in excelResult.sheets" :key="s.name" :value="s.name"
            :label="`${s.name}（${s.orders.length}张订单）`" />
        </el-select>
        <span style="color:#909399; font-size:13px">勾选要导入的订单；标「已存在」的默认不勾（这个客户单号系统里已有）</span>
      </div>
      <el-table ref="excelTable" :data="sheetOrders" border size="small" max-height="440"
        @selection-change="s => excelSelected = s" row-key="_key">
        <el-table-column type="selection" width="40" reserve-selection />
        <el-table-column type="expand" width="34">
          <template #default="{ row }">
            <el-table :data="row.lines" size="small" style="margin: 4px 12px; width: auto">
              <el-table-column type="index" label="行" width="46" />
              <el-table-column prop="name" label="品名" min-width="130" show-overflow-tooltip />
              <el-table-column prop="drawing_no" label="图号" min-width="130" show-overflow-tooltip />
              <el-table-column prop="spec" label="规格" width="130" show-overflow-tooltip />
              <el-table-column prop="material" label="材质" width="80" />
              <el-table-column prop="qty" label="数量" width="60" align="center" />
              <el-table-column v-if="showPrice" prop="unit_price" label="单价" width="90" align="right" />
              <el-table-column prop="remark" label="备注" min-width="150" show-overflow-tooltip />
            </el-table>
          </template>
        </el-table-column>
        <el-table-column label="客户" min-width="140">
          <template #default="{ row }">
            {{ row.customer_name }}
            <el-tag v-if="!row.customer_exists" type="warning" size="small" style="margin-left:4px">新客户</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="客户单号" min-width="170">
          <template #default="{ row }">
            {{ row.customer_po || '（无单号）' }}
            <el-tag v-if="row.po_exists" type="danger" size="small" style="margin-left:4px">已存在:{{ row.po_exists }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="行数" width="70" align="center">
          <template #default="{ row }">{{ row.lines.length }}</template>
        </el-table-column>
        <el-table-column prop="total_qty" label="总件数" width="80" align="center" />
        <el-table-column prop="due_date" label="交期" width="110">
          <template #default="{ row }">{{ row.due_date || '—' }}</template>
        </el-table-column>
        <el-table-column v-if="showPrice" label="金额" width="110" align="right">
          <template #default="{ row }">{{ fmtMoney(row.amount) }}</template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button v-if="excelResult" @click="excelResult = null">重新上传</el-button>
      <el-button @click="excelDialog = false">取消</el-button>
      <el-button v-if="excelResult" type="primary" :loading="importing" :disabled="!excelSelected.length" @click="doImport">
        导入选中的 {{ excelSelected.length }} 张订单
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, canSeePrice, canEntry } from '../api.js';
import { ORDER_STATUS } from '../consts.js';

const router = useRouter();

const orders = ref([]);
const customers = ref([]);
const loading = ref(false);
const filters = ref({ status: 'active', customer_id: null, month: null, q: '' });
const showPrice = canSeePrice();
const entry = canEntry();
const today = new Date().toISOString().slice(0, 10);

const reconcileDialog = ref(false);
const recPdf = ref(null);
const recXls = ref(null);
const reconciling = ref(false);
const recResult = ref(null);
const recError = ref('');
const diffConfirmed = ref(false);

// 图号核查弹窗：查这个图号在系统里出现在哪些订单
const lookupDialog = ref(false);
const lookupDno = ref('');
const lookupLoading = ref(false);
const lookupRows = ref([]);
const lookupError = ref('');
const statusText = s => ORDER_STATUS[s]?.label || s || '';

// ===== 对账调整：人工登记"客户单 A×4 → 台账 A×2 + B×2"这类对应关系 =====
// 客户采购单的图号不总是权威（镜面件并单、客户自己的编号、机架整机不拆），
// 台账按真实图纸拆开写，两边天然对不上。登记后件数能配平 = 证明没少东西，且永久留痕。
const ADJ_REASONS = {
  mirror_merge: '镜面并单（客户合并了镜像件）',
  frame_split: '机架拆分（客户按整机下单）',
  customer_code: '客户用了自己的编号',
  qty_diff: '件数不一致（已与客户确认）',
  other: '其它（见备注）'
};
// poRows = 客户采购单上对不上的每一行；每行可以被"调整"成实际的若干图号
// r.adj = { lines:[{drawing_no,qty}], qty, reason, note }
const poRows = ref([]);
const ledgerPool = ref([]);   // 台账上客户单没有的图号（供调整时挑选、并显示认领进度）
const adjDialog = ref(false);
const adjTarget = ref(null);
const adjLines = ref([]);
const adjReason = ref('mirror_merge');
const adjNote = ref('');

const sumQty = arr => arr.reduce((s, x) => s + (Number(x.qty) || 0), 0);

// 台账各图号被调整认领了多少
const claimed = computed(() => {
  const m = {};
  for (const r of poRows.value) {
    if (!r.adj) continue;
    for (const l of r.adj.lines) m[l.drawing_no] = (m[l.drawing_no] || 0) + Number(l.qty || 0);
  }
  return m;
});
const ledgerRemain = computed(() =>
  ledgerPool.value.map(x => ({ ...x, left: x.qty - (claimed.value[x.drawing_no] || 0) }))
);
const ledgerLeftQty = computed(() => ledgerRemain.value.reduce((s, x) => s + Math.max(0, x.left), 0));
const poUnadjustedQty = computed(() => sumQty(poRows.value.filter(r => !r.adj)));
const poUnbalanced = computed(() => poRows.value.filter(r => r.adj && r.adj.qty !== r.qty));

const adjLinesQty = computed(() => sumQty(adjLines.value));
const canConfirmAdjust = computed(() => {
  if (!adjTarget.value || !adjReason.value) return false;
  if (!adjLines.value.length || adjLines.value.some(l => !String(l.drawing_no || '').trim())) return false;
  // 件数必须等于采购单那一行；确实要不一样，得明确选「件数不一致」这个原因
  return adjLinesQty.value === adjTarget.value.qty || adjReason.value === 'qty_diff';
});

// 核对结果出来后，铺开"客户采购单差异行"和"台账多出来的图号"
function buildAdjPools(r) {
  let n = 0;
  poRows.value = [
    // 同图号数量对不上（如客户 4件 / 台账 2件 —— 典型的镜面并单）
    ...(r.qty_mismatch || []).map(x => ({
      key: 'q' + n++, label: x.drawing_no, drawing_no: x.drawing_no, name: x.name,
      qty: x.pdf_qty, ledger_qty: x.ledger_qty, adj: null
    })),
    // 客户单有、台账完全没有（客户用自己的编号、或台账真漏了）
    ...(r.pdf_not_in_ledger || []).map(x => ({
      key: 'p' + n++, label: x.drawing_no || x.part_no || x.name || '（未识别）',
      drawing_no: x.drawing_no || null, name: x.name,
      qty: x.qty, ledger_qty: 0, adj: null
    }))
  ].filter(x => x.qty > 0);

  // 台账里客户单没有的图号 + 数量对不上那些图号的台账件数，都是可被认领的
  const agg = new Map();
  const add = (dno, qty, name) => {
    if (!dno || !(qty > 0)) return;
    const cur = agg.get(dno) || { drawing_no: dno, qty: 0, name };
    cur.qty += qty;
    agg.set(dno, cur);
  };
  for (const x of r.ledger_not_in_pdf || []) add(x.drawing_no, x.ledger_qty, x.name);
  for (const x of r.qty_mismatch || []) add(x.drawing_no, x.ledger_qty, x.name);
  ledgerPool.value = [...agg.values()];
}

function openAdjust(row) {
  adjTarget.value = row;
  if (row.adj) {
    adjLines.value = row.adj.lines.map(l => ({ ...l }));
    adjReason.value = row.adj.reason;
    adjNote.value = row.adj.note || '';
  } else {
    // 预填：同图号台账上有多少就先填多少，剩下的差额由人补第二行
    const same = ledgerRemain.value.find(x => x.drawing_no === row.drawing_no);
    adjLines.value = same && same.left > 0
      ? [{ drawing_no: row.drawing_no, qty: same.left }]
      : [{ drawing_no: row.drawing_no || '', qty: row.qty }];
    adjReason.value = row.ledger_qty ? 'mirror_merge' : 'customer_code';
    adjNote.value = '';
  }
  adjDialog.value = true;
}

function confirmAdjust() {
  const lines = adjLines.value
    .map(l => ({ drawing_no: String(l.drawing_no).trim(), qty: Number(l.qty) }))
    .filter(l => l.drawing_no && l.qty > 0);
  adjTarget.value.adj = {
    lines, qty: sumQty(lines),
    reason: adjReason.value,
    note: adjNote.value.trim() || null
  };
  adjDialog.value = false;
}

// 提交给后端的格式：客户单这一行 → 实际的若干图号
const adjPayload = () => poRows.value.filter(r => r.adj).map(r => ({
  reason: r.adj.reason, note: r.adj.note,
  pdf_side: [{ drawing_no: r.label, qty: r.qty }],
  ledger_side: r.adj.lines
}));

async function openLookup(dno) {
  lookupDno.value = dno;
  lookupRows.value = [];
  lookupError.value = '';
  lookupLoading.value = true;
  lookupDialog.value = true;
  try {
    const { data } = await api.get('/orders/drawing-lookup', { params: { drawing_no: dno } });
    lookupRows.value = data.matches || [];
  } catch (err) {
    lookupError.value = err.response?.data?.error || '查询失败';
  } finally {
    lookupLoading.value = false;
  }
}

function openReconcile() {
  recPdf.value = null;
  recXls.value = null;
  recResult.value = null;
  recError.value = '';
  diffConfirmed.value = false;
  poRows.value = [];
  ledgerPool.value = [];
  adjNote.value = '';
  reconcileDialog.value = true;
}

function pickFile(e, which) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (which === 'pdf') recPdf.value = f; else recXls.value = f;
  recResult.value = null;
  recError.value = '';
}

async function doReconcile() {
  diffConfirmed.value = false;
  reconciling.value = true;
  recResult.value = null;
  recError.value = '';
  try {
    const fd = new FormData();
    fd.append('pdf', recPdf.value);
    fd.append('excel', recXls.value);
    const { data } = await api.post('/orders/reconcile', fd);
    recResult.value = data;
    buildAdjPools(data);
  } catch (err) {
    recError.value = err.response?.data?.error || '核对失败';
  } finally {
    reconciling.value = false;
  }
}

async function doReconcileImport() {
  importing.value = true;
  try {
    const fd = new FormData();
    fd.append('pdf', recPdf.value);
    fd.append('excel', recXls.value);
    const adj = adjPayload();
    if (adj.length) fd.append('adjustments', JSON.stringify(adj));
    const { data } = await api.post('/orders/reconcile-import', fd);
    const adjMsg = adj.length ? `，${adj.length}条调整说明已存档` : '';
    ElMessage.success(`已录入订单 ${data.order_no}（${data.pieces}件）${data.customer_created ? '，并新建了客户' : ''}，PDF已留档${adjMsg}`);
    reconcileDialog.value = false;
    load();
    router.push(`/orders/${data.order_id}`);
  } catch { /* 拦截器已提示 */ } finally {
    importing.value = false;
  }
}

const excelDialog = ref(false);
const excelParsing = ref(false);
const excelResult = ref(null);
const activeSheet = ref('');
const excelSelected = ref([]);
const importing = ref(false);
const excelTable = ref(null);

const sheetOrders = computed(() => {
  if (!excelResult.value) return [];
  const s = excelResult.value.sheets.find(x => x.name === activeSheet.value);
  return s ? s.orders : [];
});

function openExcelImport() {
  excelResult.value = null;
  excelSelected.value = [];
  excelDialog.value = true;
}

async function onExcelPicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  excelParsing.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const { data } = await api.post('/orders/parse-excel', fd);
    data.sheets.forEach((s, si) => s.orders.forEach((o, oi) => { o._key = `${si}-${oi}`; }));
    excelResult.value = data;
    const withOrders = data.sheets.filter(s => s.orders.length);
    if (!withOrders.length) {
      ElMessage.warning('这个文件里没有识别到订单数据');
      excelResult.value = null;
      return;
    }
    activeSheet.value = withOrders[withOrders.length - 1].name;
    await preselect();
  } catch { /* 已提示 */ } finally {
    excelParsing.value = false;
  }
}

async function preselect() {
  await nextTick();
  excelTable.value?.clearSelection();
  for (const row of sheetOrders.value) {
    if (!row.po_exists) excelTable.value?.toggleRowSelection(row, true);
  }
}

function onSheetChange() {
  excelSelected.value = [];
  preselect();
}

async function doImport() {
  const sel = excelSelected.value;
  await ElMessageBox.confirm(
    `确认导入 ${sel.length} 张订单（共 ${sel.reduce((s, o) => s + o.total_qty, 0)} 件板）？没见过的客户会自动建档。`,
    '确认导入', { type: 'warning', confirmButtonText: '确认导入' }
  );
  importing.value = true;
  try {
    const { data } = await api.post('/orders/import-excel', {
      orders: sel.map(o => ({
        customer_name: o.customer_name,
        customer_po: o.customer_po,
        due_date: o.due_date,
        lines: o.lines
      }))
    });
    const parts = [`成功创建 ${data.created.length} 张订单（共 ${data.created.reduce((s, c) => s + c.pieces, 0)} 件板）`];
    if (data.customers_created.length) parts.push(`新建客户：${data.customers_created.join('、')}`);
    if (data.skipped.length) parts.push(`跳过 ${data.skipped.length} 张：${data.skipped.map(s => `${s.customer_po || '?'}(${s.reason})`).join('；')}`);
    await ElMessageBox.alert(parts.join('\n'), '导入完成', { confirmButtonText: '好' });
    excelDialog.value = false;
    load();
  } catch { /* 已提示 */ } finally {
    importing.value = false;
  }
}

function fmtMoney(v) {
  if (v == null) return '—';
  return '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function load() {
  loading.value = true;
  try {
    const params = {};
    for (const [k, v] of Object.entries(filters.value)) if (v) params[k] = v;
    const { data } = await api.get('/orders', { params });
    orders.value = data.orders;
  } finally { loading.value = false; }
}

onMounted(async () => {
  load();
  const { data } = await api.get('/customers');
  customers.value = data.customers.filter(c => c.active);
});
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
.prog { color: #606266; font-size: 13px; }
.tag-special { background: #f3eefc !important; border-color: #b39ddb !important; color: #6a3fb5 !important; }
.rec-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rec-table th, .rec-table td { border: 1px solid #ebeef5; padding: 8px 12px; text-align: left; }
.rec-table th { background: #f5f7fa; font-weight: 500; }
.rec-table tr.bad td { background: #fef0f0; }
.rec-table tr.warn td { background: #fdf6ec; }
.rec-table + .diff-head { margin-top: 14px; }
.diff-head { font-size: 13px; font-weight: 500; margin: 0 0 6px; padding: 4px 8px; border-radius: 4px; }
.diff-head.danger { color: #f56c6c; background: #fef0f0; }
.diff-head.warn { color: #b88230; background: #fdf6ec; }

/* 逐行调整 */
.rec-table tr.done td { background: #f0f9eb; }
.rec-table tr.adj-detail td { background: #f0f9eb; font-size: 13px; padding-top: 2px; padding-bottom: 6px; color: #529b2e; }
.adj-src { font-size: 15px; margin-bottom: 8px; }
.adj-tip { font-size: 12px; color: #909399; line-height: 1.7; margin-bottom: 12px; }
.adj-sum { margin-top: 10px; font-size: 14px; }
.adj-warn { margin-top: 12px; font-size: 13px; padding: 6px 10px; border-radius: 4px; }
.adj-warn.danger { color: #f56c6c; background: #fef0f0; }
.adj-warn.warn { color: #b88230; background: #fdf6ec; }
.adj-warn.ok { color: #529b2e; background: #f0f9eb; }
</style>
