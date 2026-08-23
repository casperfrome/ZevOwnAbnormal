const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');


test('operatorLabel translates every supported operator and hides unknown internal values', () => {
  const context = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'scripts', 'components.js'), 'utf8'),
    context,
  );

  const expected = {
    eq: '等于（=）',
    neq: '不等于（≠）',
    gt: '大于（>）',
    gte: '大于等于（≥）',
    lt: '小于（<）',
    lte: '小于等于（≤）',
    between: '介于',
    is_null: '为空',
    is_not_null: '不为空',
    gt_threshold_ratio: '高于基线倍数',
    lt_threshold_ratio: '低于基线倍数',
  };

  for (const [operator, label] of Object.entries(expected)) {
    assert.equal(context.window.UI.operatorLabel(operator), label);
  }
  assert.equal(context.window.UI.operatorLabel('future_internal_code'), '未知条件');
  assert.equal(context.window.UI.operatorLabel(''), '未知条件');
});

test('formatTime renders backend UTC timestamps in Beijing time to seconds', () => {
  const context = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'scripts', 'components.js'), 'utf8'),
    context,
  );

  assert.equal(context.window.UI.formatTime('2026-08-23T02:21:44'), '2026-08-23 10:21:44');
  assert.equal(context.window.UI.formatTime('2026-08-23T02:21:44Z'), '2026-08-23 10:21:44');
  assert.equal(context.window.UI.formatTime('2026-08-23T10:21:44+08:00'), '2026-08-23 10:21:44');
  assert.equal(context.window.UI.formatTime(null), '—');
});
