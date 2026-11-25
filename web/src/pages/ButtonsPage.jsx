import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api.js';
import { CopyField, ErrorBox, fmtTime } from '../ui.jsx';
import { ActionEditor } from './ActionsPage.jsx';

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

  // While any button is waiting for its setup test, poll so the parameters appear on their own.
  const waiting = buttons?.some((b) => b.setup_state === 'waiting_for_test');
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [waiting, load]);

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
    if (!newName.trim() || buttons === null) return;
    run(async () => {
      const res = await api('POST', '/buttons', { name: newName.trim() });
      setRevealed(res);
      setNewName('');
    });
  };

  return (
    <section>
      <h2>我的按钮</h2>
      <ol className="muted steps">
        <li>新建按钮，把 URL 和请求头填进 Notion 按钮的「Send webhook」动作</li>
        <li>在 Notion 里点一次按钮作为<b>测试</b>：自动绑定这个自动化、读取页面参数，并把你加入白名单（不会触发 Claude）</li>
        <li>回到这里查看读取到的参数，编辑提示词；之后的点击就会发给 Claude</li>
      </ol>
      <ErrorBox error={error} />

      <form className="card row" onSubmit={create}>
        <input placeholder="新按钮名称，例如：处理 @claude 评论" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={128} />
        <button className="primary" type="submit" disabled={buttons === null || !newName.trim()}>
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
            secret={revealed?.button.id === b.id ? revealed.secret : null}
            onDismissSecret={() => setRevealed(null)}
            onReload={load}
            onPatch={(patch) => run(() => api('PATCH', `/buttons/${b.id}`, patch))}
            onRotate={() =>
              confirm('重新生成密钥后旧密钥立即失效，需要到 Notion 里更新请求头。继续？') &&
              run(async () => setRevealed(await api('POST', `/buttons/${b.id}/rotate-secret`)))
            }
            onRetest={() =>
              confirm('重新测试会解除当前绑定：下一次请求视为测试（绑定发送它的自动化、重新读取参数，不触发 Claude）。继续？') &&
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

function SetupSteps({ button, secret, onDismissSecret }) {
  return (
    <div className="card highlight">
      <h4>第 1 步：在 Notion 按钮里添加「Send webhook」动作</h4>
      <CopyField label="URL" value={button.webhook_url ?? '（服务器未配置 RELAY_URL）'} />
      <CopyField label="请求头名称" value={button.secret_header} />
      {secret ? (
        <>
          <CopyField label="请求头的值" value={secret} />
          <p className="warn small">
            请求头的值只显示这一次。
            <button className="link" onClick={onDismissSecret}>
              我已保存
            </button>
          </p>
        </>
      ) : (
        <p className="muted small">请求头的值只在新建 / 重新生成密钥时显示。</p>
      )}
      <h4>第 2 步：在 Notion 里点一次这个按钮（测试）</h4>
      <p className="muted small">
        <span className="spinner" /> 等待测试 webhook…收到后自动绑定、读取参数、生成默认提示词，这里会自动刷新。
      </p>
    </div>
  );
}

function ParameterTable({ parameters }) {
  if (!parameters.length) return <p className="muted small">测试 webhook 里没有页面属性。</p>;
  return (
    <table className="params">
      <thead>
        <tr>
          <th>参数（模板变量）</th>
          <th>类型</th>
          <th>测试时的值</th>
        </tr>
      </thead>
      <tbody>
        {parameters.map((p) => (
          <tr key={p.name}>
            <td>
              <code>{`{{${p.name}}}`}</code>
            </td>
            <td className="muted small">{p.type}</td>
            <td className="small">{formatParam(p.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatParam(v) {
  if (v === null || v === undefined || v === '') return <span className="muted">（空）</span>;
  if (Array.isArray(v)) return v.length ? v.join(', ') : <span className="muted">（空）</span>;
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

function ButtonCard({ button, actions, secret, onDismissSecret, onReload, onPatch, onRotate, onRetest, onDelete, onShowRuns }) {
  const [whitelist, setWhitelist] = useState(button.allowed_notion_user_ids.join('\n'));
  const [name, setName] = useState(button.name);
  const [showParams, setShowParams] = useState(false);
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    setWhitelist(button.allowed_notion_user_ids.join('\n'));
    setName(button.name);
  }, [button]);

  // Open the parameters + editor once the setup test arrives.
  const [prevState, setPrevState] = useState(button.setup_state);
  if (prevState !== button.setup_state) {
    setPrevState(button.setup_state);
    if (button.setup_state === 'ready') {
      setShowParams(true);
      setEditing(true);
    }
  }

  const whitelistDirty = whitelist.trim() !== button.allowed_notion_user_ids.join('\n');
  const ids = whitelist
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const action = actions.find((a) => a.id === button.action_id) ?? null;
  const waiting = button.setup_state === 'waiting_for_test';

  return (
    <div className={button.enabled ? 'card' : 'card disabled'}>
      <div className="row space">
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
        {name.trim() && name !== button.name && <button onClick={() => onPatch({ name: name.trim() })}>保存名称</button>}
        <span className={waiting ? 'badge' : 'badge ok'}>{waiting ? '等待测试' : '已配置'}</span>
        <label className="switch">
          <input type="checkbox" checked={button.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          {button.enabled ? '已启用' : '已停用'}
        </label>
      </div>

      {waiting ? (
        <SetupSteps button={button} secret={secret} onDismissSecret={onDismissSecret} />
      ) : (
        <>
          {secret && (
            <div className="card highlight">
              <CopyField label="新的请求头的值（只显示这一次）" value={secret} />
              <button onClick={onDismissSecret}>我已保存</button>
            </div>
          )}
          <div className="muted small">
            已绑定自动化 <code>{button.automation_id}</code>
            {button.sample_captured_at && <> · 参数读取于 {fmtTime(button.sample_captured_at)}</>}
          </div>

          <div className="row">
            <button onClick={() => setShowParams((v) => !v)}>
              {showParams ? '收起参数' : `查看参数（${button.parameters.length}）`}
            </button>
            <button className={editing ? '' : 'primary'} onClick={() => setEditing((v) => !v)} disabled={!action}>
              {editing ? '收起提示词' : '编辑提示词'}
            </button>
            {!action && <span className="warn small">按钮没有关联的提示词，请在「高级设置」里选择。</span>}
          </div>
          {showParams && <ParameterTable parameters={button.parameters} />}
          {editing && action && <ActionEditor key={action.id} action={action} onSaved={onReload} previewButtonId={button.id} />}
        </>
      )}

      <button className="link left" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? '▾' : '▸'} 高级设置
      </button>
      {advanced && (
        <>
          <CopyField label="URL" value={button.webhook_url ?? '（服务器未配置 RELAY_URL）'} />
          <CopyField label="请求头名称" value={button.secret_header} />
          <label>
            使用的提示词（操作模板，可与其他按钮共用）
            <select value={button.action_id ?? ''} onChange={(e) => onPatch({ action_id: e.target.value || null })}>
              <option value="">{waiting ? '（测试后自动生成）' : '（未选择，点击会被拒绝）'}</option>
              {actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.enabled ? '' : '（已停用）'}
                </option>
              ))}
            </select>
          </label>
          <label>
            允许点击的 Notion 用户 ID（每行一个；测试时自动加入发送测试的人）
            <textarea rows={3} value={whitelist} onChange={(e) => setWhitelist(e.target.value)} placeholder="1bfd872b-594c-81a2-9a19-0002e093b3e1" />
          </label>
          <div className="row">
            {whitelistDirty && (
              <button className="primary" onClick={() => onPatch({ allowed_notion_user_ids: ids })}>
                保存白名单
              </button>
            )}
            {!waiting && <button onClick={onRetest}>重新测试</button>}
            <button onClick={onRotate}>重新生成密钥</button>
          </div>
        </>
      )}

      <div className="row">
        <button onClick={onShowRuns}>查看运行记录</button>
        <button className="danger" onClick={onDelete}>
          删除
        </button>
        <span className="muted small grow right">创建于 {fmtTime(button.created_at)}</span>
      </div>
    </div>
  );
}
