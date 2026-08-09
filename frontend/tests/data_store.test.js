const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');


test('sendFeishuTestMessage posts the selected target to the system test endpoint', async () => {
  const requests = [];
  const context = {
    window: {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, message_id: 'om_frontend' }),
      };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8');
  vm.runInNewContext(source, context);

  const result = await context.window.Store.sendFeishuTestMessage('chat_id', 'oc_group');

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, message_id: 'om_frontend' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/v1/tests/feishu-message');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    receive_id_type: 'chat_id',
    receive_id: 'oc_group',
  });
});
