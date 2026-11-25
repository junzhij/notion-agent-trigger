import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api.js';
import { ErrorBox, fmtTime } from '../ui.jsx';

const STATUS_LABELS = {
  test: '配置测试',
  queued: '排队中',
  rejected: '已拒绝',
  dispatched: '已发送',
  failed: '失败',
  done: '完成',
};

export default function RunsPage({ buttonId, onClearFilter }) {
  const api = useApi();
  const [runs, setRuns] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [status, setStatus] = useState('');
  const [buttons, setButtons] = useState([]);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  const query = useCallback(
    (after) => {
      const params = new URLSearchParams({ limit: '25' });
      if (buttonId) params.set('button_id', buttonId);
      if (status) params.set('status', status);
      if (after) params.set('cursor', after);
      return `/runs?${params}`;
    },
    [buttonId, status],
  );

  const load = useCallback(async () => {
    try {
      const [r, b] = await Promise.all([api('GET', query()), api('GET', '/buttons')]);
      setRuns(r.runs);
      setCursor(r.next_cursor);
      setButtons(b.buttons);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api, query]);

  useEffect(() => {
    load();
  }, [load]);

  const more = async () => {
    try {
      const r = await api('GET', query(cursor));
      setRuns((prev) => [...prev, ...r.runs]);
      setCursor(r.next_cursor);
    } catch (e) {
      setError(e);
    }
  };

  const buttonById = Object.fromEntries(buttons.map((b) => [b.id, b]));

  const allowClicker = async (run) => {
    const b = buttonById[run.button_id];
    if (!b || !run.clicker_notion_user_id) return;
    if (!confirm(`把 ${run.clicker_notion_user_id} 加入「${b.name}」的白名单？`)) return;
    try {
      await api('PATCH', `/buttons/${b.id}`, {
        allowed_notion_user_ids: [...b.allowed_notion_user_ids, run.clicker_notion_user_id],
      });
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section>
      <h2>运行记录</h2>
      <div className="row">
        {buttonId && (
          <span className="badge">
            按钮：{buttonById[buttonId]?.name ?? buttonId}{' '}
            <button className="link" onClick={onClearFilter}>
              ×
            </button>
          </span>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button onClick={load}>刷新</button>
      </div>
      <ErrorBox error={error} />

      {runs === null ? (
        <p className="muted">加载中…</p>
      ) : runs.length === 0 ? (
        <p className="muted">暂无记录。</p>
      ) : (
        <table className="runs">
          <thead>
            <tr>
              <th>时间</th>
              <th>按钮</th>
              <th>页面</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const b = buttonById[r.button_id];
              const canAllow =
                r.reject_reason === 'clicker_not_allowed' && b && !b.allowed_notion_user_ids.includes(r.clicker_notion_user_id);
              return (
                <tr key={r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="clickable">
                  <td className="nowrap">{fmtTime(r.created_at)}</td>
                  <td>{b?.name ?? <span className="muted">已删除</span>}</td>
                  <td>
                    {r.page_url ? (
                      <a href={r.page_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        {r.page_title || r.page_id}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className={`status ${r.status}`}>{STATUS_LABELS[r.status] ?? r.status}</span>
                  </td>
                  <td>
                    {r.reject_reason_text && <div>{r.reject_reason_text}</div>}
                    {r.error && <div className="warn">{r.error}</div>}
                    {r.session_url && (
                      <a href={r.session_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        会话
                      </a>
                    )}
                    {canAllow && (
                      <button
                        className="link"
                        onClick={(e) => {
                          e.stopPropagation();
                          allowClicker(r);
                        }}
                      >
                        加入白名单
                      </button>
                    )}
                    {open === r.id && (
                      <div className="details" onClick={(e) => e.stopPropagation()}>
                        <div className="muted small">
                          事件 {r.id} · 点击者 {r.clicker_notion_user_id ?? '—'} · 第 {r.attempt ?? '?'} 次投递
                        </div>
                        {r.missing_variables?.length > 0 && <div className="warn">未知变量：{r.missing_variables.join('、')}</div>}
                        {r.rendered_text && <pre className="preview">{r.rendered_text}</pre>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {cursor && (
        <button className="more" onClick={more}>
          加载更多
        </button>
      )}
    </section>
  );
}
