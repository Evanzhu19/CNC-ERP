export const STAGE_NAMES = {
  milling: '铣磨',
  cnc: 'CNC',
  grinding: '精磨',
  plating_sent: '电镀外发',
  plating_back: '电镀回厂',
  shipped: '已出货'
};

export const ROLE_NAMES = {
  admin: '总经理',
  procurement: '采购主管',
  finance: '财务',
  cnc_manager: 'CNC主管',
  clerk: '文员',
  follower: '跟单',
  programmer: '编程',
  outsourcer: '外发'
};

export const VENDOR_TYPES = { milling: '铣磨', cnc: 'CNC加工', grinding: '磨床加工', plating: '电镀', other: '其他' };

export const OUT_PROC_LABELS = { milling: '铣磨', cnc: 'CNC', grinding: '精磨', plating: '电镀' };

export const PIECE_FLAGS = { repair: '维修中', rework: '返工中', redraw: '改图暂停' };

export function outTypeLabel(typeCsv) {
  return String(typeCsv || '').split(',').filter(Boolean).map(t => OUT_PROC_LABELS[t] || t).join('+');
}

export function outDoingLabel(typeCsv) {
  const parts = String(typeCsv || '').split(',').filter(Boolean);
  if (parts.length === 1 && parts[0] === 'plating') return '电镀中';
  return outTypeLabel(typeCsv) + '外发';
}

export const ORDER_STATUS = {
  active: { label: '进行中', type: 'primary' },
  closed: { label: '已结案', type: 'success' },
  void: { label: '已作废', type: 'info' }
};

export const WIP_LABELS = { milling: '铣磨中', cnc: 'CNC加工中', grinding: '精磨中' };

export function pieceStatus(piece) {
  if (piece.stages.shipped) return { label: '已出货', type: 'success' };
  if (piece.flag && PIECE_FLAGS[piece.flag]) {
    return { label: PIECE_FLAGS[piece.flag] + (piece.flag_note ? `·${piece.flag_note}` : ''), type: 'primary', special: true };
  }
  const openOut = (piece.outsourcing || []).find(o => !o.returned_date && (o.status === 'open' || o.status === 'draft'));
  if (openOut) {
    if (openOut.status === 'draft') {
      return { label: `${outTypeLabel(openOut.type)}外发待确认·${openOut.vendor_name}`, type: 'warning' };
    }
    return { label: `${outDoingLabel(openOut.type)}·${openOut.vendor_name}`, type: 'warning' };
  }
  if (piece.wip_stage && WIP_LABELS[piece.wip_stage]) {
    const extra = piece.wip_note ? `·${piece.wip_note}` : '';
    return { label: WIP_LABELS[piece.wip_stage] + extra, type: 'primary', wip: true };
  }
  if (piece.stages.plating_back) return { label: '待出货', type: 'primary' };
  if (piece.stages.grinding) return { label: '待电镀', type: 'info' };
  if (piece.stages.cnc) return { label: '待精磨', type: 'info' };
  if (piece.stages.milling) return { label: '待CNC', type: 'info' };
  return { label: '待铣磨', type: 'info' };
}
