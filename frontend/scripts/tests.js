/* ============================================================
   tests.js — System integration checks
   ============================================================ */
window.TestsModule = (function () {
  const { escapeHtml } = UI;
  const placeholders = {
    open_id: '例如：ou_xxxxxxxxxxxxxxxx',
    union_id: '例如：on_xxxxxxxxxxxxxxxx',
    user_id: '例如：xxxxxxxxxxxxxxxx',
    email: '例如：name@example.com',
    chat_id: '例如：oc_xxxxxxxxxxxxxxxx',
  };

  function renderResult(resultEl, type, title, detail) {
    resultEl.className = `test-result ${type}`;
    resultEl.innerHTML = `
      <div class="test-result-icon">${type === 'success' ? Icon.check({ size: 18 }) : Icon.alert({ size: 18 })}</div>
      <div>
        <div class="test-result-title">${escapeHtml(title)}</div>
        <div class="test-result-detail">${escapeHtml(detail)}</div>
      </div>
    `;
  }

  function render(contentEl, opts) {
    opts.actionsEl.innerHTML = '';
    contentEl.innerHTML = `
      <div class="tests-layout animate-rise">
        <section class="section test-message-card">
          <div class="section-header">
            <div>
              <div class="section-title">${Icon.message({ size: 17 })} 飞书消息发送测试</div>
              <div class="section-subtitle">验证当前飞书凭证能否通过异常规则共用链路触达指定目标</div>
            </div>
            <span class="badge primary">LIVE CHECK</span>
          </div>
          <div class="section-body test-message-body">
            <div class="test-chain-note">
              <span class="test-chain-mark">${Icon.link({ size: 16 })}</span>
              <div>
                <strong>与异常推送共用发送链路</strong>
                <p>测试成功代表当前凭证可以触达本次填写的目标，不会执行规则或生成异常数据。</p>
              </div>
            </div>

            <form id="feishu-test-form" novalidate>
              <div class="form-grid test-target-grid">
                <div class="field">
                  <label class="field-label" for="test-receive-id-type"><span>receive_id_type<span class="field-required">*</span></span></label>
                  <select class="select mono" id="test-receive-id-type" required aria-required="true">
                    <option value="open_id">open_id · 应用内用户</option>
                    <option value="union_id">union_id · 开发商内用户</option>
                    <option value="user_id">user_id · 租户内用户</option>
                    <option value="email">email · 用户邮箱</option>
                    <option value="chat_id">chat_id · 群聊</option>
                  </select>
                  <div class="field-help">ID 类型必须与下方接收者 ID 一致</div>
                </div>
                <div class="field">
                  <label class="field-label" for="test-receive-id"><span>接收者 ID<span class="field-required">*</span></span></label>
                  <input class="input mono" id="test-receive-id" maxlength="255" autocomplete="off" required aria-required="true" aria-describedby="test-receive-id-help test-receive-id-error" placeholder="${placeholders.open_id}" />
                  <div class="field-help" id="test-receive-id-help">由用户或群聊的实际标识提供</div>
                  <div class="field-error" id="test-receive-id-error" hidden>请填写接收者 ID</div>
                </div>
              </div>

              <div class="test-message-preview">
                <div class="test-preview-label">固定测试消息</div>
                <div class="test-preview-content">【Sentinel 测试消息】飞书消息发送测试成功。</div>
              </div>

              <div class="test-result" id="feishu-test-result" role="status" aria-live="polite"></div>

              <div class="test-form-footer">
                <a class="test-doc-link" href="https://open.feishu.cn/document/server-docs/im-v1/message/create" target="_blank" rel="noreferrer">
                  ${Icon.external({ size: 14 })} 查看飞书接口文档
                </a>
                <button class="btn btn-accent" id="feishu-test-submit" type="submit">
                  ${Icon.send({ size: 16 })}发送测试消息
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    `;

    const form = contentEl.querySelector('#feishu-test-form');
    const typeInput = contentEl.querySelector('#test-receive-id-type');
    const receiveIdInput = contentEl.querySelector('#test-receive-id');
    const receiveIdError = contentEl.querySelector('#test-receive-id-error');
    const resultEl = contentEl.querySelector('#feishu-test-result');
    const submitBtn = contentEl.querySelector('#feishu-test-submit');

    typeInput.addEventListener('change', () => {
      receiveIdInput.placeholder = placeholders[typeInput.value];
      resultEl.className = 'test-result';
      resultEl.innerHTML = '';
    });

    receiveIdInput.addEventListener('input', () => {
      if (receiveIdInput.value.trim()) {
        receiveIdInput.classList.remove('error');
        receiveIdInput.removeAttribute('aria-invalid');
        receiveIdError.hidden = true;
      }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const receiveId = receiveIdInput.value.trim();
      if (!receiveId) {
        receiveIdInput.classList.add('error');
        receiveIdInput.setAttribute('aria-invalid', 'true');
        receiveIdError.hidden = false;
        receiveIdInput.focus();
        UI.toast({ type: 'warning', title: '请填写接收者 ID' });
        return;
      }

      receiveIdInput.classList.remove('error');
      receiveIdInput.removeAttribute('aria-invalid');
      receiveIdError.hidden = true;
      const original = submitBtn.innerHTML;
      submitBtn.innerHTML = '<span class="btn-spinner"></span>发送中…';
      submitBtn.disabled = true;
      form.setAttribute('aria-busy', 'true');
      resultEl.className = 'test-result';
      resultEl.innerHTML = '';

      try {
        const result = await Store.sendFeishuTestMessage(typeInput.value, receiveId);
        renderResult(resultEl, 'success', '消息发送成功', `message_id: ${result.message_id}`);
        UI.toast({ type: 'success', title: '飞书测试消息已发送', desc: `message_id: ${result.message_id}` });
      } catch (error) {
        renderResult(resultEl, 'error', '消息发送失败', error.message);
        UI.toast({ type: 'error', title: '飞书测试失败', desc: error.message });
      } finally {
        submitBtn.innerHTML = original;
        submitBtn.disabled = false;
        form.removeAttribute('aria-busy');
      }
    });
  }

  return { render };
})();
