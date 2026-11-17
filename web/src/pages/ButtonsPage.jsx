import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api.js';
import { CopyField, ErrorBox, fmtTime } from '../ui.jsx';

export default function ButtonsPage({ onShowRuns }) {
  const api = useApi();
  const [buttons, setButtons] = useState(null);
  const [actions, setActions] = useState([]);
  const [error, setError] = useState(null);
  const [revealed, setRevealed] = useState(null); // { button, secret }
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, a] = await Promise.all([api('GET', '/buttons'), api('GET', '/actions')]);
      setButtons(b.buttons);
      setActions(a.actions);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn) => {
    try {
      setError(null);
      await fn();
      await load();
    } catch (e) {
      setError(e);
    }
  };

  const create = (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    run(async () => {
      const res = await api('POST', '/buttons', { name: newName.trim(), action_id: actions[0]?.id ?? null });
      setRevealed(res);
      setNewName('');
    });
  };

  return (
    <section>
      <h2>我的按钮</h2>
      <p className="muted">
        每个按钮对应 Notion 里一个「Send webhook」动作。新建后把 URL 和请求头填进 Notion；第一次被点击时会自动绑定该 Notion
        自动化。白名单为空时任何人点击都会被拒绝。
      </p>
      <ErrorBox error={error} />

      {revealed && <SecretReveal data={revealed} onClose={() => setRevealed(null)} />}

      <form className="card row" onSubmit={create}>
        <input placeholder="新按钮名称，例如：补全笔记" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={128} />
        <button className="primary" type="submit">
          新建按钮
        </button>
      </form>

      {buttons === null ? (
        <p className="muted">加载中…</p>
      ) : buttons.length === 0 ? (
        <p className="muted">还没有按钮。</p>
      ) : (
        buttons.map((b) => (
          <ButtonCard
            key={b.id}
            button={b}
            actions={actions}
            onPatch={(patch) => run(() => api('PATCH', `/buttons/${b.id}`, patch))}
            onRotate={() =>
              confirm('重新生成密钥后旧密钥立即失效，需要到 Notion 里更新请求头。继续？') &&
              run(async () => setRevealed(await api('POST', `/buttons/${b.id}/rotate-secret`)))
            }
            onUnbind={() =>
              confirm('解除绑定后，下一次调用这个地址的 Notion 自动化会被重新绑定。继续？') &&
              run(() => api('POST', `/buttons/${b.id}/unbind`))
            }
            onDelete={() => confirm(`删除按钮「${b.name}」？`) && run(() => api('DELETE', `/buttons/${b.id}`))}
            onShowRuns={() => onShowRuns(b.id)}
          />
        ))
      )}
    </section>
  );
}

function SecretReveal({ data, onClose }) {
  const { button, secret } = data;
  return (
    <div className="card highlight">
      <h3>「{button.name}」的 Notion 配置</h3>
      <p>
        <strong>密钥只显示这一次</strong>，关闭后无法再查看（只能重新生成）。在 Notion 按钮里添加「Send webhook」动作，填写：
      </p>
      <CopyField label="URL" value={button.webhook_url ?? '（服务器未配置 RELAY_URL）'} />
      <CopyField label="请求头名称" value={button.secret_header} />
      <CopyField label="请求头的值" value={secret} />
      <button onClick={onClose}>我已保存，关闭</button>
    </div>
  );
}

function ButtonCard({ button, actions, onPatch, onRotate, onUnbind, onDelete, onShowRuns }) {
  const [whitelist, setWhitelist] = useState(button.allowed_notion_user_ids.join('\n'));
  const [name, setName] = useState(button.name);

  useEffect(() => {
    setWhitelist(button.allowed_notion_user_ids.join('\n'));
    setName(button.name);
  }, [button]);

  const whitelistDirty = whitelist.trim() !== button.allowed_notion_user_ids.join('\n');
  const ids = whitelist
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className={button.enabled ? 'card' : 'card disabled'}>
      <div className="row space">
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
        {name.trim() && name !== button.name && <button onClick={() => onPatch({ name: name.trim() })}>保存名称</button>}
        <label className="switch">
          <input type="checkbox" checked={button.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          {button.enabled ? '已启用' : '已停用'}
        </label>
      </div>

      <CopyField label="URL" value={button.webhook_url ?? '（服务器未配置 RELAY_URL）'} />
      <CopyField label="请求头名称" value={button.secret_header} />

      <div className="grid">
        <label>
          操作
          <select value={button.action_id ?? ''} onChange={(e) => onPatch({ action_id: e.target.value || null })}>
            <option value="">（未选择，点击会被拒绝）</option>
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.enabled ? '' : '（已停用）'}
              </option>
            ))}
          </select>
        </label>
        <div>
          绑定状态
          <div className="muted small">
            {button.bound ? (
              <>
                已绑定自动化 <code>{button.automation_id}</code>{' '}
                <button className="link" onClick={onUnbind}>
                  解除绑定
                </button>
              </>
            ) : (
              '未绑定（第一次点击时绑定）'
            )}
          </div>
        </div>
      </div>

      <label>
        允许点击的 Notion 用户 ID（每行一个）
        <textarea rows={3} value={whitelist} onChange={(e) => setWhitelist(e.target.value)} placeholder="1bfd872b-594c-81a2-9a19-0002e093b3e1" />
      </label>
      <p className="muted small">不知道自己的 ID？先点一次按钮，再到「运行记录」里把被拒绝的点击者一键加入白名单。</p>

      <div className="row">
        {whitelistDirty && (
          <button className="primary" onClick={() => onPatch({ allowed_notion_user_ids: ids })}>
            保存白名单
          </button>
        )}
        <button onClick={onShowRuns}>查看运行记录</button>
        <button onClick={onRotate}>重新生成密钥</button>
        <button className="danger" onClick={onDelete}>
          删除
        </button>
        <span className="muted small grow right">创建于 {fmtTime(button.created_at)}</span>
      </div>
    </div>
  );
}
