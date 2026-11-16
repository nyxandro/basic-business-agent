// /agents/:agentId?thread=… (spec, section 7): one conversation with the agent under its header.
// Without ?thread a new conversation starts with a fresh id. Until the admin sets models up the
// employee sees why instead of the input.
import type { AgentSummary } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { ChatHeader } from '../layout/ChatHeader.tsx';
import { EmptyInstallation } from '../layout/EmptyInstallation.tsx';
import { rememberAgent, useShell } from '../layout/AppShell.tsx';
import { IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { useToast } from '../ui/Toast.tsx';
import { ProjectChip } from '../projects/ProjectChip.tsx';
import { useThreadProject } from '../projects/use-thread-project.ts';
import { LostProjectNotice } from '../projects/LostProjectNotice.tsx';
import { deleteThread } from './api.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { RenameThreadDialog } from './RenameThreadDialog.tsx';

function ThreadActions({ threadId, onDeleted, onRenamed }: { threadId: string; onDeleted: () => void; onRenamed: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  async function remove() {
    setOpen(false);
    if (!(await confirm({ title: ru.chat.deleteConfirm, confirmLabel: ru.chat.deleteThread, danger: true }))) return;
    try {
      await deleteThread(threadId);
      toast(ru.chat.threadDeleted);
      onDeleted();
    } catch (raw) {
      setError(asApiError(raw));
    }
  }
  return (
    <MenuAnchor>
      <IconButton icon="dots" label={ru.shell.threadMenu} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} label={ru.shell.threadMenu}>
        <MenuItem
          icon="edit"
          onSelect={() => {
            setOpen(false);
            setRenaming(true);
          }}
        >
          {ru.shell.rename}
        </MenuItem>
        <MenuItem icon="trash" danger onSelect={() => void remove()}>
          {ru.chat.deleteThread}
        </MenuItem>
      </Menu>
      {error ? <ErrorBanner error={error} /> : null}
      {renaming ? (
        <RenameThreadDialog
          threadId={threadId}
          onClose={() => setRenaming(false)}
          onRenamed={(title) => {
            setRenaming(false);
            onRenamed(title);
          }}
        />
      ) : null}
    </MenuAnchor>
  );
}

function Conversation({ agent, agents, threadId }: { agent: AgentSummary; agents: AgentSummary[]; threadId: string }) {
  const me = useMe();
  const { wide, openMenu, refreshThreads, nameThread } = useShell();
  const navigate = useNavigate();
  const project = useThreadProject(threadId);
  useEffect(() => rememberAgent(agent.id), [agent.id]);
  const startNew = () => {
    refreshThreads();
    void navigate(`/agents/${encodeURIComponent(agent.id)}?thread=${crypto.randomUUID()}`, { replace: true });
  };
  return (
    <>
      <ChatHeader agent={agent} agents={agents} wide={wide} onOpenMenu={openMenu} actions={<ThreadActions threadId={threadId} onDeleted={startNew} onRenamed={(title) => (nameThread(threadId, title), refreshThreads())} />} />
      {me.modelsConfigured ? (
        <ChatPanel
          key={threadId}
          agent={agent}
          threadId={threadId}
          onRunFinished={refreshThreads}
          onThreadTitled={refreshThreads}
          composerExtra={<ProjectChip threadId={threadId} {...project} />}
          composerNotice={project.lost ? <LostProjectNotice threadId={threadId} lost={project.lost} onDone={() => project.changed(null)} /> : null}
        />
      ) : (
        <EmptyInstallation />
      )}
    </>
  );
}

export function ChatPage() {
  const { agentId } = useParams();
  const [params] = useSearchParams();
  const { agents } = useShell();
  const location = useLocation();
  const threadId = params.get('thread');

  if (!agentId) throw new Error('ChatPage needs the :agentId route parameter');
  if (!threadId) return <Navigate to={`?thread=${crypto.randomUUID()}`} replace state={location.state as unknown} />;
  if (!agents) return <DelayedBar />;
  const agent = agents.find((a) => a.id === agentId);
  // A link to an agent the person does not have opens an available one, with a line why.
  if (!agent) return <Navigate to="/" replace state={{ agentUnavailable: true }} />;
  return <Conversation agent={agent} agents={agents} threadId={threadId} />;
}
