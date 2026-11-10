"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { SessionGate } from "../../../components/session-gate";
import { ForbiddenState } from "../../../components/states";
import { rememberBranch, sectionOf, switchBranchPath } from "../../../lib/navigation/branch-route";
import { canSee, findNavItem, visibleNavItems } from "../../../lib/navigation/nav-items";
import { sessionStore } from "../../../lib/session/session";
import type { SessionState } from "../../../lib/session/session-store";

type Authenticated = Extract<SessionState, { status: "authenticated" }>;

function BranchShell({ session, branchId, children }: { readonly session: Authenticated; readonly branchId: string; readonly children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { me, branches } = session;
  const current = branches.find((b) => b.id === branchId);

  useEffect(() => {
    if (current) rememberBranch(current.id);
  }, [current]);

  if (!current) {
    return (
      <div className="min-h-screen pt-24">
        <ForbiddenState
          description="Esta filial não existe, está inativa ou você não tem acesso a ela."
          action={
            <Link href="/" className="text-sm font-medium text-primary underline">
              Escolher outra filial
            </Link>
          }
        />
      </div>
    );
  }

  const selectBranch = (nextId: string) => {
    rememberBranch(nextId);
    router.push(
      switchBranchPath(pathname, nextId, (segment) => {
        const item = findNavItem(segment);
        return item !== undefined && canSee(item, me, nextId);
      }),
    );
  };

  const logout = () => {
    void sessionStore.logout().then(() => router.replace("/"));
  };

  return (
    <AppShell
      me={me}
      branches={branches}
      branchId={branchId}
      navItems={visibleNavItems(me, branchId)}
      activeSegment={sectionOf(pathname)}
      onSelectBranch={selectBranch}
      onLogout={logout}
    >
      {children}
    </AppShell>
  );
}

export default function BranchLayout({ children }: { children: ReactNode }) {
  const { branchId } = useParams<{ branchId: string }>();
  return (
    <SessionGate>
      {(session) => (
        <BranchShell session={session} branchId={branchId}>
          {children}
        </BranchShell>
      )}
    </SessionGate>
  );
}
