"use client";

import type { BranchSummaryDto, MeDto } from "@erp/contracts";
import { useState, type ReactNode } from "react";
import type { NavItem } from "../lib/navigation/nav-items";
import { BranchSelector } from "./branch-selector";
import { SideNav } from "./side-nav";

/**
 * Shell do app: cabeçalho (organização, filial, usuário), menu lateral e conteúdo. Desktop (lg+): menu fixo; tablet e
 * menor: menu em gaveta aberta pelo botão do cabeçalho.
 */
export function AppShell({
  me,
  branches,
  branchId,
  navItems,
  activeSegment,
  onSelectBranch,
  onLogout,
  children,
}: {
  readonly me: MeDto;
  readonly branches: readonly BranchSummaryDto[];
  readonly branchId: string;
  readonly navItems: readonly NavItem[];
  readonly activeSegment: string;
  readonly onSelectBranch: (branchId: string) => void;
  readonly onLogout: () => void;
  readonly children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4">
        <button
          type="button"
          className="rounded-md p-2 text-muted hover:bg-surface-muted lg:hidden"
          aria-label={menuOpen ? "Fechar menu" : "Abrir menu"}
          aria-expanded={menuOpen}
          aria-controls="app-sidebar"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg aria-hidden viewBox="0 0 20 20" className="size-5" fill="currentColor">
            <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h14v2H3z" />
          </svg>
        </button>
        <span className="truncate font-semibold">{me.organization.name}</span>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <BranchSelector branches={branches} value={branchId} onSelect={onSelectBranch} />
          <span className="hidden truncate text-sm text-muted md:inline" title={me.user.employeeNumber}>
            {me.user.name}
          </span>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface-muted"
          >
            Sair
          </button>
        </div>
      </header>

      <div className="flex">
        {menuOpen ? (
          <button
            type="button"
            aria-label="Fechar menu"
            className="fixed inset-0 top-14 z-10 bg-foreground/30 lg:hidden"
            onClick={closeMenu}
          />
        ) : null}
        <aside
          id="app-sidebar"
          className={`fixed top-14 bottom-0 z-20 w-64 shrink-0 overflow-y-auto border-r border-line bg-surface transition-transform lg:sticky lg:h-[calc(100vh-3.5rem)] lg:translate-x-0 ${
            menuOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <SideNav items={navItems} branchId={branchId} activeSegment={activeSegment} onNavigate={closeMenu} />
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
