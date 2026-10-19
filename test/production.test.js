'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../public/shared/production');
const { extractJson } = require('../lib/ai');

const mock = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mock-response.json'), 'utf8'));

const EXPECTED = `10.18 6:00 - 10.19 6:00生产情况：

#07
1. BP1592.02 (12) B473

#08
1. BE2751 (11) B586
2. BE2867 (13) B339
3. BE2956.01 (12) B586
4. BE2963.01 (1) B586
5. BE2956 (13) B586
6. BE2752.01 (12) B586
7. BE3161 (13) B586
8. BE3354 (7) B586

#09
1. BE3112 (5) B342
2. BE3390.02 (1) B342
3. BE1917.01 (12) B228

#10
1. BE2846 (13) B339
2. BE2963.01 (11) B586
3. BE3161.01 (12) B586
4. BE2970.01 (4) B586

共计：152片`;

test('10.18 照片：输出标准格式，合计由代码计算', () => {
  const data = P.normalize(mock);
  assert.strictEqual(P.format(data), EXPECTED);
  const t = P.computeTotals(data);
  assert.strictEqual(t.total, 152);
  assert.deepStrictEqual(t.perMachine.map((m) => m.subtotal), [12, 82, 18, 40]);
});

test('不确定项进入核对区', () => {
  const issues = P.validate(P.normalize(mock));
  const where = issues.filter((i) => i.source === 'ai').map((i) => i.where);
  assert.ok(where.some((w) => w.includes('BE3390.02')));
  assert.ok(where.some((w) => w.includes('BE2846')));
  assert.ok(issues.some((i) => i.msg.includes('重复') && i.where.includes('BE2963.01')));
});

test('纸上合计与验算不符时报错', () => {
  const data = P.normalize({ ...mock, paper_total: 157 });
  const e = P.validate(data).find((i) => i.where === '共计');
  assert.ok(e && e.level === 'error' && e.msg.includes('相差 5'));
});

test('时间段规范化', () => {
  assert.strictEqual(P.normPeriod('10.18~10.19'), '10.18 6:00 - 10.19 6:00');
  assert.strictEqual(P.normPeriod('10/18-10/19'), '10.18 6:00 - 10.19 6:00');
  assert.strictEqual(P.normPeriod('10.18 8:00 ~ 10.19 8:00'), '10.18 8:00 - 10.19 8:00');
  assert.strictEqual(P.normPeriod('10.18～10.19', '7:30'), '10.18 7:30 - 10.19 7:30');
});

test('解析编辑后的文本并重新验算', () => {
  const { data, statedTotal } = P.parseText(EXPECTED.replace('共计：152片', '共计：157片').replace('BE2970.01 (4)', 'BE2970.01（9）'));
  assert.strictEqual(statedTotal, 157);
  assert.strictEqual(P.computeTotals(data).total, 157);
  assert.strictEqual(data.period, '10.18 6:00 - 10.19 6:00');
  assert.strictEqual(data.machines.length, 4);
});

test('规则校验：片数越界、批次号格式', () => {
  const issues = P.validate(P.normalize({ period: 'x', machines: [{ machine: '7', lots: [{ lot: 'BE27S1', qty: 31 }, { lot: 'BE1000', qty: 'l' }] }] }));
  assert.ok(issues.some((i) => i.msg.includes('31')));
  assert.ok(issues.some((i) => i.msg.includes('BE27S1')));
  assert.ok(issues.some((i) => i.msg.includes('片数缺失')));
});

test('从带代码块的 AI 回复中提取 JSON', () => {
  assert.deepStrictEqual(extractJson('好的：\n```json\n{"a":1}\n```'), { a: 1 });
});
