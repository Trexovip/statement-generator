const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const settings = require('./settings');
const { toMajor, format } = require('./money');

const TYPE_LABEL = { credit: 'Credit', debit: 'Debit', failed: 'Failed', reverse: 'Reversal' };
const opts = () => settings.get().statement;
const numFmtOf = () => (opts().decimals > 0 ? `#,##0.${'0'.repeat(opts().decimals)}` : '#,##0');
const curOf = () => (opts().currency ? ` (${opts().currency})` : '');

function rowNotes(r) {
  const notes = [];
  if (r.category === 'failed') notes.push(`Failed: ${format(r.amount)} not applied`);
  if (r.reverseOf) notes.push(`Reverses ${r.reverseOf}`);
  return notes.concat(r.flags).join('; ');
}

function safeName(s) {
  return String(s).replace(/[^\w.-]+/g, '_').slice(0, 80);
}

// ----------------------------------------------------------------- CSV ----
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(st) {
  const cur = curOf();
  const lines = [
    ['Wallet', st.wallet.walletId],
    ['Name', st.wallet.name || ''],
    ['Period', `${st.period.from} to ${st.period.to || ''}`],
    ['Opening balance', toMajor(st.summary.opening)],
    ['Closing balance', toMajor(st.summary.closing)],
    [],
    ['Date', 'Time (UTC)', 'Reference', 'Type', 'Description', `Credit${cur}`, `Debit${cur}`, `Balance${cur}`, 'API balance', 'Notes'],
  ];
  for (const r of st.rows) {
    lines.push([
      r.date,
      r.occurredAt.slice(11, 19),
      r.ref,
      TYPE_LABEL[r.category] || r.category,
      r.description,
      r.effect > 0 ? toMajor(r.effect) : '',
      r.effect < 0 ? toMajor(-r.effect) : '',
      toMajor(r.balance),
      r.apiBalance === null ? '' : toMajor(r.apiBalance),
      rowNotes(r),
    ]);
  }
  return '\uFEFF' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

// --------------------------------------------------------------- Excel ----
function addStatementSheet(wb, st, sheetName = 'Statement') {
  const numFmt = numFmtOf();
  const config = opts();
  const ws = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 10 }] });
  ws.columns = [
    { width: 12 }, { width: 10 }, { width: 22 }, { width: 11 }, { width: 38 },
    { width: 15 }, { width: 15 }, { width: 16 }, { width: 15 }, { width: 50 },
  ];
  const s = st.summary;
  ws.addRow([`Statement — wallet ${st.wallet.walletId}${st.wallet.name ? ' (' + st.wallet.name + ')' : ''}`]).font = { bold: true, size: 14 };
  ws.addRow([`Period: ${st.period.from} to ${st.period.to || ''}${config.currency ? '   Currency: ' + config.currency : ''}`]);
  ws.addRow([]);
  const sumRows = [
    ['Opening balance', toMajor(s.opening)],
    ['Credits', toMajor(s.credit.amount), `${s.credit.count} txns`],
    ['Debits', toMajor(s.debit.amount), `${s.debit.count} txns`],
    ['Reversals (net)', toMajor(s.reverse.net), `${s.reverse.count} txns`],
    ['Closing balance', toMajor(s.closing), `Failed: ${s.failed.count} txns (${format(s.failed.amount)}) not applied`],
  ];
  for (const r of sumRows) {
    const row = ws.addRow(r);
    row.getCell(1).font = { bold: true };
    row.getCell(2).numFmt = numFmt;
  }
  ws.addRow([]);
  const header = ws.addRow(['Date', 'Time (UTC)', 'Reference', 'Type', 'Description', 'Credit', 'Debit', 'Balance', 'API balance', 'Notes']);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D3557' } }; });

  for (const r of st.rows) {
    const row = ws.addRow([
      r.date,
      r.occurredAt.slice(11, 19),
      r.ref,
      TYPE_LABEL[r.category] || r.category,
      r.description,
      r.effect > 0 ? toMajor(r.effect) : null,
      r.effect < 0 ? toMajor(-r.effect) : null,
      toMajor(r.balance),
      r.apiBalance === null ? null : toMajor(r.apiBalance),
      rowNotes(r),
    ]);
    [6, 7, 8, 9].forEach((i) => (row.getCell(i).numFmt = numFmt));
    if (r.category === 'failed') row.font = { color: { argb: 'FF8A8F98' } };
    if (r.flags.some((f) => f !== 'Balance matches API again')) {
      row.getCell(10).font = { color: { argb: 'FFB3261E' } };
    }
  }
  return ws;
}

async function toExcel(st) {
  const wb = new ExcelJS.Workbook();
  addStatementSheet(wb, st);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function summaryExcel(wallets) {
  const numFmt = numFmtOf();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('All wallets', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Wallet ID', key: 'id', width: 22 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Opening', key: 'opening', width: 15, style: { numFmt } },
    { header: 'Credits', key: 'credit', width: 15, style: { numFmt } },
    { header: 'Debits', key: 'debit', width: 15, style: { numFmt } },
    { header: 'Reversals (net)', key: 'rev', width: 16, style: { numFmt } },
    { header: 'Closing', key: 'closing', width: 15, style: { numFmt } },
    { header: 'Transactions', key: 'count', width: 13 },
    { header: 'Failed', key: 'failed', width: 9 },
    { header: 'Issues', key: 'flags', width: 9 },
    { header: 'Synced until', key: 'until', width: 13 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Last error', key: 'err', width: 50 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const w of wallets) {
    ws.addRow({
      id: w.wallet_id,
      name: w.name || '',
      opening: toMajor(w.opening_balance),
      credit: toMajor(w.total_credit),
      debit: toMajor(w.total_debit),
      rev: toMajor(w.total_reversed),
      closing: toMajor(w.closing_balance),
      count: w.txn_count,
      failed: w.failed_count,
      flags: w.flag_count,
      until: w.synced_until || '',
      status: w.sync_status,
      err: w.last_error || '',
    });
  }
  const totalRow = ws.addRow({
    id: 'TOTAL',
    opening: { formula: `SUM(C2:C${wallets.length + 1})` },
    credit: { formula: `SUM(D2:D${wallets.length + 1})` },
    debit: { formula: `SUM(E2:E${wallets.length + 1})` },
    rev: { formula: `SUM(F2:F${wallets.length + 1})` },
    closing: { formula: `SUM(G2:G${wallets.length + 1})` },
  });
  totalRow.font = { bold: true };
  ws.autoFilter = { from: 'A1', to: 'M1' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ----------------------------------------------------------------- PDF ----
function toPdf(st) {
  const config = opts();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const cols = [
      { key: 'date', label: 'Date', w: 62 },
      { key: 'ref', label: 'Reference', w: 105 },
      { key: 'type', label: 'Type', w: 52 },
      { key: 'desc', label: 'Description', w: 0 }, // takes remaining width
      { key: 'credit', label: 'Credit', w: 72, right: true },
      { key: 'debit', label: 'Debit', w: 72, right: true },
      { key: 'balance', label: 'Balance', w: 80, right: true },
      { key: 'notes', label: 'Notes', w: 130 },
    ];
    cols[3].w = width - cols.reduce((a, c) => a + c.w, 0);

    const fit = (text, w) => {
      let s = String(text || '');
      if (doc.widthOfString(s) <= w - 4) return s;
      while (s.length && doc.widthOfString(s + '…') > w - 4) s = s.slice(0, -1);
      return s + '…';
    };

    // Header block
    const s = st.summary;
    doc.font('Helvetica-Bold').fontSize(15).text(`Account statement`, left, 36);
    doc.font('Helvetica').fontSize(10)
      .text(`Wallet: ${st.wallet.walletId}${st.wallet.name ? '  ·  ' + st.wallet.name : ''}`)
      .text(`Period: ${st.period.from} to ${st.period.to || ''}${config.currency ? '    Currency: ' + config.currency : ''}`)
      .moveDown(0.5);

    const box = [
      ['Opening balance', format(s.opening)],
      [`Credits (${s.credit.count})`, format(s.credit.amount)],
      [`Debits (${s.debit.count})`, format(s.debit.amount)],
      [`Reversals net (${s.reverse.count})`, format(s.reverse.net)],
      [`Failed, not applied (${s.failed.count})`, format(s.failed.amount)],
      ['Closing balance', format(s.closing)],
    ];
    const bw = width / box.length;
    const by = doc.y;
    box.forEach(([label, value], i) => {
      doc.font('Helvetica').fontSize(8).fillColor('#555').text(label, left + i * bw, by, { width: bw - 8 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(value, left + i * bw, by + 12, { width: bw - 8 });
    });
    doc.y = by + 36;

    const rowH = 15;
    const drawHeader = () => {
      const y = doc.y;
      doc.rect(left, y, width, rowH).fill('#1D3557');
      let x = left;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff');
      for (const c of cols) {
        const pad = c.key === 'notes' ? 10 : 2;
        doc.text(c.label, x + pad, y + 4, { width: c.w - pad - 2, align: c.right ? 'right' : 'left', lineBreak: false });
        x += c.w;
      }
      doc.fillColor('#000');
      doc.y = y + rowH;
    };

    drawHeader();
    st.rows.forEach((r, idx) => {
      if (doc.y + rowH > doc.page.height - doc.page.margins.bottom - 14) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        drawHeader();
      }
      const y = doc.y;
      if (idx % 2 === 1) doc.rect(left, y, width, rowH).fill('#F2F4F7');
      const hasFlag = r.flags.some((f) => f !== 'Balance matches API again');
      const vals = {
        date: r.date,
        ref: r.ref,
        type: TYPE_LABEL[r.category] || r.category,
        desc: r.description,
        credit: r.effect > 0 ? format(r.effect) : '',
        debit: r.effect < 0 ? format(-r.effect) : '',
        balance: format(r.balance),
        notes: rowNotes(r),
      };
      let x = left;
      doc.font('Helvetica').fontSize(7.5);
      for (const c of cols) {
        let color = '#000';
        if (r.category === 'failed') color = '#8A8F98';
        if (c.key === 'notes' && hasFlag) color = '#B3261E';
        const pad = c.key === 'notes' ? 10 : 2;
        doc.fillColor(color).text(fit(vals[c.key], c.w - pad + 2), x + pad, y + 4, {
          width: c.w - pad - 2, align: c.right ? 'right' : 'left', lineBreak: false,
        });
        x += c.w;
      }
      doc.y = y + rowH;
    });
    if (!st.rows.length) doc.moveDown().font('Helvetica').fontSize(10).fillColor('#000').text('No transactions in this period.');

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // allow writing in the margin without creating a new page
      doc.font('Helvetica').fontSize(7).fillColor('#777').text(
        `Wallet ${st.wallet.walletId}  —  page ${i + 1} of ${range.count}  —  generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        left, doc.page.height - bottom + 10, { width, align: 'center', lineBreak: false }
      );
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

module.exports = { toCsv, toExcel, toPdf, summaryExcel, safeName };
