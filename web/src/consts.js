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
  finance: '财务',
  cnc_manager: 'CNC主管',
  clerk: '文员',
  follower: '跟单',
  programmer: '编程',
  outsourcer: '外发'
};

export const VENDOR_TYPES = { cnc: 'CNC加工', grinding: '磨床加工', plating: '电镀', other: '其他' };

export const OUTSOURCE_TYPES = {
  cnc: { label: 'CNC加工', tag: 'primary', doing: 'CNC外发' },
  grinding: { label: '精磨', tag: 'success', doing: '精磨外发' },
  plating: { label: '电镀', tag: 'warning', doing: '电镀中' }
};

export const ORDER_STATUS = {
  active: { label: '进行中', type: 'primary' },
  closed: { label: '已结案', type: 'success' },
  void: { label: '已作废', type: 'info' }
};

export const WIP_LABELS = { milling: '铣磨中', cnc: 'CNC加工中', grinding: '精磨中' };

export function pieceStatus(piece) {
  if (piece.stages.shipped) return { label: '已出货', type: 'success' };
  const openOut = (piece.outsourcing || []).find(o => !o.returned_date && (o.status === 'open' || o.status === 'draft'));
  if (openOut) {
    const t = OUTSOURCE_TYPES[openOut.type] || { doing: '外发中', label: '' };
    if (openOut.status === 'draft') {
      return { label: `${t.label}外发待确认·${openOut.vendor_name}`, type: 'warning' };
    }
    return { label: `${t.doing}·${openOut.vendor_name}`, type: 'warning' };
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
