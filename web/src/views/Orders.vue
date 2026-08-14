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

      <!-- 图号差异明细：按方向分列，每个图号可"查一下"在系统里出现在哪些订单 -->
      <div v-if="recResult.line_diff" style="margin-top:12px">
        <!-- ① 会少做：PDF有、台账没有 —— 最危险，重点核 -->
        <template v-if="(recResult.pdf_not_in_ledger || []).length">
          <div class="diff-head danger">⚠ 客户PDF上有、台账里没有（台账可能漏了 → 会少做，务必核实）</div>
          <table class="rec-table">
            <thead><tr><th>图号 / 内容</th><th style="width:70px">PDF</th><th style="width:80px">台账</th><th style="width:88px">核查</th></tr></thead>
            <tbody>
              <tr v-for="(ex, i) in recResult.pdf_not_in_ledger" :key="'p' + i" class="bad">
                <td>{{ ex.drawing_no || ex.text }}<span v-if="ex.name" style="color:#909399">（{{ ex.name }}）</span></td>
                <td>{{ ex.qty }} 件</td>
                <td style="color:#f56c6c">缺</td>
                <td><el-button v-if="ex.drawing_no" size="small" text type="primary" @click="openLookup(ex.drawing_no)">查一下</el-button></td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ② 可能串单/拆分：台账有、PDF没有 -->
        <template v-if="(recResult.ledger_not_in_pdf || []).length">
          <div class="diff-head warn">台账里有、客户PDF上没有（机架拆分件属正常；若是本单不该有的板 = 记错单/串单）</div>
          <table class="rec-table">
            <thead><tr><th>图号</th><th style="width:70px">PDF</th><th style="width:80px">台账</th><th style="width:88px">核查</th></tr></thead>
            <tbody>
              <tr v-for="(l, i) in recResult.ledger_not_in_pdf" :key="'l' + i" class="warn">
                <td>{{ l.drawing_no }}<span v-if="l.name" style="color:#909399">（{{ l.name }}）</span></td>
                <td style="color:#e6a23c">无</td>
                <td>{{ l.ledger_qty }} 件</td>
                <td><el-button size="small" text type="primary" @click="openLookup(l.drawing_no)">查一下</el-button></td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ③ 同图号数量对不上 -->
        <template v-if="(recResult.qty_mismatch || []).length">
          <div class="diff-head warn">同一图号，两边数量对不上</div>
          <table class="rec-table">
            <thead><tr><th>图号</th><th style="width:70px">PDF</th><th style="width:80px">台账</th><th style="width:88px">核查</th></tr></thead>
            <tbody>
              <tr v-for="(m, i) in recResult.qty_mismatch" :key="'m' + i" class="warn">
                <td>{{ m.drawing_no }}<span v-if="m.name" style="color:#909399">（{{ m.name }}）</span></td>
                <td>{{ m.pdf_qty }} 件</td>
                <td>{{ m.ledger_qty }} 件</td>
                <td><el-button size="small" text type="primary" @click="openLookup(m.drawing_no)">查一下</el-button></td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ④ 手动登记对应关系：说明差异怎么来的，件数对上就证明没少东西 -->
        <div class="adj-box">
          <div class="adj-title">登记对应关系（把差异交代清楚，件数对得上就证明没少东西）</div>
          <div class="adj-tip">
            例：客户把一对镜像件并成一个图号发过来 —— 勾左边「MA0112664C007 4件」+ 右边「MA0112664C007 2件」和「MA0177076C001 2件」，
            选「镜面并单」，登记后就是 <b>4件 → 2件+2件，件数对上</b>，这条说明会永久存进订单。
          </div>

          <div class="adj-cols">
            <div class="adj-col">
              <div class="adj-col-h">客户单这边 <span :class="pdfPoolLeft ? 'left-bad' : 'left-ok'">剩 {{ pdfPoolLeft }} 件未交代</span></div>
              <div v-if="!pdfPool.length" class="adj-empty">（都交代完了）</div>
              <el-checkbox v-for="p in pdfPool" :key="p.key" v-model="p.checked" class="adj-item">
                {{ p.label }} <b>{{ p.qty }}件</b>
              </el-checkbox>
            </div>
            <div class="adj-col">
              <div class="adj-col-h">台账这边 <span :class="ledgerPoolLeft ? 'left-warn' : 'left-ok'">剩 {{ ledgerPoolLeft }} 件未交代</span></div>
              <div v-if="!ledgerPool.length" class="adj-empty">（都交代完了）</div>
              <el-checkbox v-for="l in ledgerPool" :key="l.key" v-model="l.checked" class="adj-item">
                {{ l.label }} <b>{{ l.qty }}件</b>
              </el-checkbox>
            </div>
          </div>

          <div class="adj-actions">
            <el-select v-model="adjReason" size="small" style="width:230px" placeholder="选原因">
              <el-option v-for="(lab, k) in ADJ_REASONS" :key="k" :value="k" :label="lab" />
            </el-select>
            <el-input v-model="adjNote" size="small" style="flex:1; min-width:140px" placeholder="备注（选填，如：图纸互为镜面，规格加工要求一致）" maxlength="200" />
            <span class="adj-bal" v-if="pickedPdfQty || pickedLedgerQty">
              选中 {{ pickedPdfQty }} 件 → {{ pickedLedgerQty }} 件
              <b v-if="pickedPdfQty === pickedLedgerQty" style="color:#67c23a">✓对上</b>
              <b v-else style="color:#f56c6c">✗差{{ Math.abs(pickedPdfQty - pickedLedgerQty) }}件</b>
            </span>
            <el-button size="small" type="primary" :disabled="!canAddAdj" @click="addAdjustment">登记这一组</el-button>
          </div>

          <table v-if="adjRows.length" class="rec-table" style="margin-top:10px">
            <thead><tr><th>已登记的对应关系</th><th style="width:96px">件数</th><th style="width:150px">原因</th><th style="width:60px"></th></tr></thead>
            <tbody>
              <tr v-for="(a, i) in adjRows" :key="'a' + i">
                <td>
                  {{ a.pdf_side.map(x => x.drawing_no + ' ' + x.qty + '件').join(' + ') || '（无）' }}
                  →
                  {{ a.ledger_side.map(x => x.drawing_no + ' ' + x.qty + '件').join(' + ') || '（无）' }}
                  <div v-if="a.note" style="color:#909399; font-size:12px">备注：{{ a.note }}</div>
                </td>
                <td>
                  <span v-if="a.pdf_qty === a.ledger_qty" style="color:#67c23a">{{ a.pdf_qty }} ✓对上</span>
                  <span v-else style="color:#f56c6c">{{ a.pdf_qty }}→{{ a.ledger_qty }} ✗</span>
                </td>
                <td style="font-size:12px">{{ ADJ_REASONS[a.reason] }}</td>
                <td><el-button size="small" text type="danger" @click="removeAdjustment(i)">撤销</el-button></td>
              </tr>
            </tbody>
          </table>

          <div v-if="pdfPoolLeft" class="adj-warn danger">
            ⚠ 还有 {{ pdfPoolLeft }} 件是客户单上要的、但没交代去向 —— 这部分有<b>少做</b>的风险，请确认台账是不是漏了。
          </div>
          <div v-else-if="ledgerPoolLeft" class="adj-warn warn">
            台账这边还剩 {{ ledgerPoolLeft }} 件没交代（客户单上没有）。是拆分件就登记一下；如果本单根本不该有这些板，可能是记错了PO。
          </div>
          <div v-else-if="unbalancedAdj.length" class="adj-warn warn">
            有 {{ unbalancedAdj.length }} 组登记的件数<b>没配平</b>（上表标 ✗）。件数对不上就说明还有东西没交代清楚，建议撤销重登。
          </div>
          <div v-else class="adj-warn ok">✓ 两边差异都已交代清楚，件数对得上。</div>
        </div>
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
          {{ pdfPoolLeft ? `还有${pdfPoolLeft}件客户单上的没交代，我确认台账没漏，照录`
             : unbalancedAdj.length ? `有${unbalancedAdj.length}组登记件数没配平，我确认无误，照录`
             : '我已核对差异，确认按台账录入' }}
        </el-checkbox>
        <el-button type="primary" :loading="importing" :disabled="recResult.line_diff && !diffConfirmed" @click="doReconcileImport">
          {{ recResult.line_diff ? '确认录入' : '核对通过，录入' }}
        </el-button>
      </template>
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
const pdfPool = ref([]);      // 客户单这边待交代的
const ledgerPool = ref([]);   // 台账这边待交代的
const adjRows = ref([]);      // 已登记的组
const adjReason = ref('mirror_merge');
const adjNote = ref('');

const sumQty = arr => arr.reduce((s, x) => s + x.qty, 0);
const pdfPoolLeft = computed(() => sumQty(pdfPool.value));
const ledgerPoolLeft = computed(() => sumQty(ledgerPool.value));
const pickedPdfQty = computed(() => sumQty(pdfPool.value.filter(x => x.checked)));
const pickedLedgerQty = computed(() => sumQty(ledgerPool.value.filter(x => x.checked)));
const canAddAdj = computed(() => (pickedPdfQty.value > 0 || pickedLedgerQty.value > 0) && !!adjReason.value);
// 已登记但件数不平的组（如 0→24）：池子清空不代表就没问题，这种必须单独喊出来
const unbalancedAdj = computed(() => adjRows.value.filter(a => a.pdf_qty !== a.ledger_qty));

// 核对结果出来后，把两个方向的差异灌进"待交代"池
function buildAdjPools(r) {
  adjRows.value = [];
  adjNote.value = '';
  let n = 0;
  pdfPool.value = [
    ...(r.pdf_not_in_ledger || []).map(x => ({
      key: 'p' + n++, checked: false, qty: x.qty,
      label: x.drawing_no || x.part_no || x.name || '（未识别）'
    })),
    ...(r.qty_mismatch || []).map(x => ({
      key: 'p' + n++, checked: false, qty: x.pdf_qty, label: x.drawing_no
    }))
  ].filter(x => x.qty > 0);
  let m = 0;
  ledgerPool.value = [
    ...(r.ledger_not_in_pdf || []).map(x => ({
      key: 'l' + m++, checked: false, qty: x.ledger_qty, label: x.drawing_no
    })),
    ...(r.qty_mismatch || []).map(x => ({
      key: 'l' + m++, checked: false, qty: x.ledger_qty, label: x.drawing_no
    }))
  ].filter(x => x.qty > 0);
}

function addAdjustment() {
  const picked = arr => arr.filter(x => x.checked).map(x => ({ drawing_no: x.label, qty: x.qty }));
  const pdfSide = picked(pdfPool.value);
  const ledgerSide = picked(ledgerPool.value);
  adjRows.value.push({
    reason: adjReason.value,
    note: adjNote.value.trim() || null,
    pdf_side: pdfSide, ledger_side: ledgerSide,
    pdf_qty: sumQty(pdfSide), ledger_qty: sumQty(ledgerSide)
  });
  // 登记过的从待交代池里移走
  pdfPool.value = pdfPool.value.filter(x => !x.checked);
  ledgerPool.value = ledgerPool.value.filter(x => !x.checked);
  adjNote.value = '';
}

function removeAdjustment(i) {
  const a = adjRows.value[i];
  let n = Date.now();
  // 撤销：把这组的图号退回待交代池
  pdfPool.value.push(...a.pdf_side.map(x => ({ key: 'p' + n++, checked: false, qty: x.qty, label: x.drawing_no })));
  ledgerPool.value.push(...a.ledger_side.map(x => ({ key: 'l' + n++, checked: false, qty: x.qty, label: x.drawing_no })));
  adjRows.value.splice(i, 1);
}

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
  pdfPool.value = [];
  ledgerPool.value = [];
  adjRows.value = [];
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
    if (adjRows.value.length) fd.append('adjustments', JSON.stringify(adjRows.value));
    const { data } = await api.post('/orders/reconcile-import', fd);
    const adjMsg = adjRows.value.length ? `，${adjRows.value.length}条对账说明已存档` : '';
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

/* 对账调整登记 */
.adj-box { margin-top: 16px; padding: 12px; border: 1px solid #e4e7ed; border-radius: 6px; background: #fafafa; }
.adj-title { font-weight: 500; margin-bottom: 6px; }
.adj-tip { font-size: 12px; color: #909399; line-height: 1.7; margin-bottom: 10px; }
.adj-cols { display: flex; gap: 12px; }
.adj-col { flex: 1; background: #fff; border: 1px solid #ebeef5; border-radius: 4px; padding: 8px 10px; }
.adj-col-h { font-size: 13px; color: #606266; margin-bottom: 6px; }
.adj-col-h .left-bad { color: #f56c6c; }
.adj-col-h .left-warn { color: #e6a23c; }
.adj-col-h .left-ok { color: #67c23a; }
.adj-empty { color: #c0c4cc; font-size: 13px; padding: 4px 0; }
.adj-item { display: block; margin: 0 0 2px; height: 26px; }
.adj-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.adj-bal { font-size: 13px; color: #606266; }
.adj-warn { margin-top: 10px; font-size: 13px; padding: 6px 10px; border-radius: 4px; }
.adj-warn.danger { color: #f56c6c; background: #fef0f0; }
.adj-warn.warn { color: #b88230; background: #fdf6ec; }
.adj-warn.ok { color: #529b2e; background: #f0f9eb; }
</style>
