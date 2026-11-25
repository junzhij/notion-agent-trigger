import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api.js';
import { ErrorBox, fmtTime } from '../ui.jsx';

const URL_HINT = 'https://api.anthropic.com/v1/claude_code/routines/trig_…/fire';

export default function CredentialsPage() {
  const api = useApi();
  const [credentials, setCredentials] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setCredentials((await api('GET', '/credentials')).credentials);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section>
      <h2>Claude 凭证</h2>
      <p className="muted">
        在 claude.ai 的定时任务里选择 <b>API</b> 触发，保存后把触发地址和 token 填到这里。token 加密保存，之后只显示末 4 位。
        操作没有指定凭证时，使用最新的已启用凭证。
      </p>
      <ErrorBox error={error} />
      {adding ? (
        <CredentialForm
          onCancel={() => setAdding(false)}
          onSubmit={async (data) => {
            await api('POST', '/credentials', data);
            setAdding(false);
            await load();
          }}
        />
      ) : (
        <button className="primary" onClick={() => setAdding(true)}>
          ＋ 添加凭证
        </button>
      )}
      {credentials === null ? (
        <p className="muted">加载中…</p>
      ) : credentials.length === 0 ? (
        !adding && <p className="muted">还没有凭证。没有凭证时，点击只会记录为「排队中」，不会触发 Claude。</p>
      ) : (
        credentials.map((c) => <CredentialCard key={c.id} credential={c} onChanged={load} />)
      )}
    </section>
  );
}

function CredentialForm({ initial, onSubmit, onCancel, tokenOptional = false }) {
  const [name, setName] = useState(initial?.name ?? 'Notion Answer');
  const [url, setUrl] = useState(initial?.routine_fire_url ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = { name, routine_fire_url: url.trim() };
      if (token.trim()) data.token = token.trim();
      await onSubmit(data);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <ErrorBox error={error} />
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} required />
      </label>
      <label>
        触发地址（URL）
        <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_HINT} required />
      </label>
      <label>
        Token{tokenOptional && <span className="muted small">（留空则不修改）</span>}
        <input
          className="mono"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="sk-ant-oat01-…"
          required={!tokenOptional}
        />
      </label>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          保存
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function CredentialCard({ credential: c, onChanged }) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const run = async (fn) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e);
    }
  };

  if (editing) {
    return (
      <CredentialForm
        initial={c}
        tokenOptional
        onCancel={() => setEditing(false)}
        onSubmit={async (data) => {
          await api('PATCH', `/credentials/${c.id}`, data);
          setEditing(false);
          await onChanged();
        }}
      />
    );
  }

  return (
    <div className={c.enabled ? 'card' : 'card disabled'}>
      <ErrorBox error={error} />
      <div className="row space">
        <strong>{c.name}</strong>
        <label className="switch">
          <input
            type="checkbox"
            checked={c.enabled}
            onChange={(e) => run(async () => {
              await api('PATCH', `/credentials/${c.id}`, { enabled: e.target.checked });
              await onChanged();
            })}
          />
          {c.enabled ? '已启用' : '已停用'}
        </label>
      </div>
      <div className="muted small mono">{c.routine_fire_url}</div>
      <div className="small">
        Token：<code>••••{c.token_last4}</code> · 上次使用：{fmtTime(c.last_used_at)}
      </div>
      {c.last_error && <p className="warn">上次错误：{c.last_error}</p>}
      {testResult && (
        <p className={testResult.ok ? 'small' : 'warn'}>
          {testResult.ok ? (
            <>
              测试成功，已创建会话：
              <a href={testResult.session_url} target="_blank" rel="noreferrer">
                打开
              </a>
            </>
          ) : (
            `测试失败：${testResult.error}`
          )}
        </p>
      )}
      <div className="row">
        <button
          disabled={testing}
          onClick={() => {
            if (!confirm('测试会真的触发一次定时任务（创建一个会话并消耗额度），继续？')) return;
            setTesting(true);
            run(async () => {
              setTestResult(await api('POST', `/credentials/${c.id}/test`, {}));
              await onChanged();
            }).finally(() => setTesting(false));
          }}
        >
          {testing ? '测试中…' : '测试'}
        </button>
        <button onClick={() => setEditing(true)}>修改 / 替换 token</button>
        <button
          className="danger"
          onClick={() => {
            if (!confirm(`删除凭证「${c.name}」？`)) return;
            run(async () => {
              await api('DELETE', `/credentials/${c.id}`);
              await onChanged();
            });
          }}
        >
          删除
        </button>
        <span className="muted small grow right">添加于 {fmtTime(c.created_at)}</span>
      </div>
    </div>
  );
}
