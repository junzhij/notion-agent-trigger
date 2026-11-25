import { useState } from 'react';
import { Show, SignInButton, UserButton } from '@clerk/react';
import ActionsPage from './pages/ActionsPage.jsx';
import ButtonsPage from './pages/ButtonsPage.jsx';
import RunsPage from './pages/RunsPage.jsx';
import CredentialsPage from './pages/CredentialsPage.jsx';

const TABS = [
  { id: 'buttons', label: '我的按钮' },
  { id: 'actions', label: '操作模板' },
  { id: 'runs', label: '运行记录' },
  { id: 'credentials', label: 'Claude 凭证' },
];

export default function App() {
  const [tab, setTab] = useState('buttons');
  const [runsFilter, setRunsFilter] = useState(null);

  return (
    <>
      <header className="topbar">
        <strong>Notion 按钮后台</strong>
        <Show when="signed-in">
          <nav>
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <UserButton />
        </Show>
      </header>
      <main className="container">
        <Show when="signed-out">
          <section className="card center">
            <p>请先登录。</p>
            <SignInButton mode="modal">
              <button className="primary">登录</button>
            </SignInButton>
          </section>
        </Show>
        <Show when="signed-in">
          {tab === 'buttons' && (
            <ButtonsPage
              onShowRuns={(buttonId) => {
                setRunsFilter(buttonId);
                setTab('runs');
              }}
            />
          )}
          {tab === 'actions' && <ActionsPage />}
          {tab === 'credentials' && <CredentialsPage />}
          {tab === 'runs' && <RunsPage buttonId={runsFilter} onClearFilter={() => setRunsFilter(null)} />}
        </Show>
      </main>
    </>
  );
}
