import type { PropsWithChildren } from 'react';
import { useApp } from '../store/app';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { ToastStack } from './Toast';
import { ConfirmModal } from './ConfirmModal';
import { Onboarding } from './Onboarding';
import { SeedPhraseModal } from './SeedPhraseModal';
import { MIcon } from './MIcon';

export function Layout({ children }: PropsWithChildren) {
  const route = useApp((s) => s.route);
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <Topbar />
        <main
          key={route.name}
          className="flex-1 min-h-0 overflow-y-auto page-transition"
          style={{ padding: '16px 22px' }}
        >
          <div className="mx-auto max-w-[1280px] flex flex-col">{children}</div>
        </main>
      </div>
      <ToastStack />
      <ConfirmModal />
      <Onboarding />
      <SeedPhraseModal />
    </div>
  );
}
