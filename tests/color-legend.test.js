// "อ่านสี" / "Colours" legends: one colour per line site-wide — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const DOT = /🟢|🟡|🟠|🔴|🔵/gu;
// every tooltip paragraph that lists two or more colour dots
const LEGENDS = [...HTML.matchAll(/<p>(<b>[^<]*<\/b>[^\n]*?)<\/p>/g)].map((m) => m[1]).filter((p) => (p.match(DOT) || []).length >= 2);

test('every colour legend on the page splits into one line per colour (Thai and English)', async () => {
  const sb = await runAllScripts(makeSandbox());
  assert.ok(LEGENDS.length >= 40, 'found ' + LEGENDS.length + ' legends');
  assert.ok(LEGENDS.some((p) => p.startsWith('<b>อ่านสี')) && LEGENDS.some((p) => p.startsWith('<b>Colours')));
  for (const inner of LEGENDS) {
    const out = sb.colorLegendHtml(inner);
    assert.ok(out, 'not split: ' + inner.slice(0, 60));
    const lines = [...out.matchAll(/<span class="legend-line">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
    // no text lost or reordered, only the " · " separators become line breaks
    const label = inner.match(/^<b>[^<]*<\/b>/)[0];
    assert.equal(label + ' ' + lines.join(' · '), inner);
    // green (or whichever colour comes first) opens the first line, every colour gets its own line
    assert.match(lines[0], /^(🟢|🟡|🟠|🔴|🔵)/u, inner.slice(0, 60));
    for (const l of lines) assert.ok((l.replace(/\([^)]*\)/g, '').match(DOT) || []).length <= 1, 'two colours on one line: ' + l);
  }
});

test('no legend uses the same colour for two different levels', () => {
  for (const inner of LEGENDS) {
    const body = inner.replace(/^<b>[^<]*<\/b>/, '').replace(/\([^)]*\)/g, '');
    const firsts = body.split(' · ').map((seg) => (seg.match(DOT) || [])[0]).filter(Boolean);
    assert.equal(new Set(firsts).size, firsts.length, 'repeated colour in: ' + inner.slice(0, 80));
  }
});

test('Buffett legend: green, yellow, red on separate lines, the note stays with red', async () => {
  const sb = await runAllScripts(makeSandbox());
  const out = sb.colorLegendHtml('<b>อ่านสี:</b> 🟢 ต่ำกว่า 100% = ถูก · 🟡 100% ถึง 150% = เริ่มแพง · 🔴 150% ขึ้นไป = แพงมาก (พีคราว 160% · ช่วงหลัง 200%)');
  assert.equal(out, '<span class="legend-head"><b>อ่านสี:</b></span>'
    + '<span class="legend-line">🟢 ต่ำกว่า 100% = ถูก</span>'
    + '<span class="legend-line">🟡 100% ถึง 150% = เริ่มแพง</span>'
    + '<span class="legend-line">🔴 150% ขึ้นไป = แพงมาก (พีคราว 160% · ช่วงหลัง 200%)</span>');
  // plain paragraphs and already-split ones are left alone
  assert.equal(sb.colorLegendHtml('<b>ทำไมสำคัญ:</b> ราคาขึ้น · ราคาลง'), null);
  assert.equal(sb.colorLegendHtml(out), null);
});
