import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../api.js';
import { ErrorBox, fmtTime } from '../ui.jsx';

const DEFAULT_TEMPLATE = `请处理 Notion 页面：{{page_url}}（页面 ID：{{page_id}}）

知识点：{{知识点}}
小节：{{小节}}
教材页码：{{教材页码}}

要求：……`;

export default function ActionsPage() {
  const api = useApi();
  const [actions, setActions] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api('GET', '/actions');
      setActions(res.actions);
      setError(null);
      return res.actions;
    } catch (e) {
      setError(e);
      return null;
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    try {
      const res = await api('POST', '/actions', { name: '新操作', prompt_template: DEFAULT_TEMPLATE });
      await load();
      setSelectedId(res.action.id);
    } catch (e) {
      setError(e);
    }
  };

  const selected = actions?.find((a) => a.id === selectedId) ?? null;

  return (
    <section>
      <h2>操作模板</h2>
      <p className="muted">
        操作就是发给 AI 的提示词模板。点击按钮时，用页面属性替换 <code>{'{{属性名}}'}</code> 得到最终文本。
      </p>
      <ErrorBox error={error} />
      <div className="split">
        <aside className="card list">
          <button className="primary" onClick={create}>
            ＋ 新建操作
          </button>
          {actions === null ? (
            <p className="muted">加载中…</p>
          ) : (
            actions.map((a) => (
              <button key={a.id} className={a.id === selectedId ? 'list-item active' : 'list-item'} onClick={() => setSelectedId(a.id)}>
                {a.name}
                {!a.enabled && <span className="badge">停用</span>}
              </button>
            ))
          )}
        </aside>
        <div className="grow">
          {selected ? (
            <ActionEditor
              key={selected.id}
              action={selected}
              onSaved={load}
              onDeleted={async () => {
                setSelectedId(null);
                await load();
              }}
            />
          ) : (
            <p className="muted">选择或新建一个操作。</p>
          )}
        </div>
      </div>
    </section>
  );
}

export function ActionEditor({ action, onSaved, onDeleted, previewButtonId = null }) {
  const api = useApi();
  const [name, setName] = useState(action.name);
  const [template, setTemplate] = useState(action.prompt_template);
  const [enabled, setEnabled] = useState(action.enabled);
  const [credentialId, setCredentialId] = useState(action.credential_id ?? '');
  const [credentials, setCredentials] = useState([]);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef(null);

  // Debounced live preview rendered on the server with the sample Notion payload.
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        setPreview(await api('POST', '/preview', { prompt_template: template, button_id: previewButtonId }));
      } catch (e) {
        setError(e);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [api, template, previewButtonId]);

  useEffect(() => {
    api('GET', '/credentials')
      .then((res) => setCredentials(res.credentials))
      .catch(setError);
  }, [api]);

  const dirty =
    name !== action.name ||
    template !== action.prompt_template ||
    enabled !== action.enabled ||
    credentialId !== (action.credential_id ?? '');

  const save = async () => {
    try {
      setError(null);
      await api('PATCH', `/actions/${action.id}`, {
        name,
        prompt_template: template,
        enabled,
        credential_id: credentialId || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      await onSaved();
    } catch (e) {
      setError(e);
    }
  };

  const remove = async () => {
    if (!confirm(`删除操作「${action.name}」？`)) return;
    try {
      await api('DELETE', `/actions/${action.id}`);
      await onDeleted();
    } catch (e) {
      setError(e);
    }
  };

  const insert = (name) => {
    const el = textareaRef.current;
    const token = `{{${name}}}`;
    if (!el) return setTemplate((t) => t + token);
    const { selectionStart: s, selectionEnd: e } = el;
    setTemplate((t) => t.slice(0, s) + token + t.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + token.length;
    });
  };

  return (
    <div className="card">
      <ErrorBox error={error} />
      <div className="row space">
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {enabled ? '已启用' : '已停用'}
        </label>
      </div>

      <label>
        使用的 Claude 凭证
        <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
          <option value="">默认（最新的已启用凭证）</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（••••{c.token_last4}）{c.enabled ? '' : '［停用］'}
            </option>
          ))}
        </select>
      </label>

      <label>
        提示词模板
        <textarea ref={textareaRef} rows={12} value={template} onChange={(e) => setTemplate(e.target.value)} className="mono" />
      </label>

      {preview && (
        <>
          <div className="vars">
            <span className="muted small">插入变量：</span>
            {preview.available_variables.map((v) => (
              <button key={v.name} className={v.builtin ? 'chip builtin' : 'chip'} title={v.description ?? '页面属性'} onClick={() => insert(v.name)}>
                {v.name}
              </button>
            ))}
          </div>
          <h4>
            预览：实际发给 Claude 的文本
            <span className="muted small">
              {preview.payload_source === 'button_sample' ? '（用测试 webhook 收到的页面渲染）' : '（用示例页面「费马引理」渲染）'}
            </span>
          </h4>
          {preview.missing.length > 0 && <p className="warn">未知变量（会被替换为空）：{preview.missing.join('、')}</p>}
          {preview.tooLong && <p className="warn">渲染结果超过 {preview.max_length} 字符。</p>}
          <pre className="preview">{preview.text}</pre>
        </>
      )}

      <div className="row">
        <button className="primary" disabled={!dirty} onClick={save}>
          {saved ? '已保存' : '保存'}
        </button>
        {onDeleted && (
          <button className="danger" onClick={remove}>
            删除
          </button>
        )}
        <span className="muted small grow right">更新于 {fmtTime(action.updated_at)}</span>
      </div>
    </div>
  );
}
