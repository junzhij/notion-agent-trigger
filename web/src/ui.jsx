import { useState } from 'react';

export function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="error">出错了：{error.message}</div>;
}

export function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <span className="muted small">{label}</span>
      <code>{value}</code>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}
