"use client";

import type { BranchSummaryDto } from "@erp/contracts";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SessionGate } from "../components/session-gate";
import { ActionButton, EmptyState, LoadingState } from "../components/states";
import { branchPath, pickInitialBranch, readLastBranch } from "../lib/navigation/branch-route";
import { sessionStore } from "../lib/session/session";

/** `/`: leva para a última filial usada (se ainda operável) ou para a primeira de `GET /me/branches`. */
function RedirectToBranch({ branches }: { readonly branches: readonly BranchSummaryDto[] }) {
  const router = useRouter();
  const target = pickInitialBranch(branches, readLastBranch());

  useEffect(() => {
    if (target !== null) router.replace(branchPath(target));
  }, [router, target]);

  if (target !== null) return <LoadingState fullScreen label="Abrindo a filial…" />;
  return (
    <div className="min-h-screen pt-24">
      <EmptyState
        title="Nenhuma filial disponível"
        description="Você ainda não tem acesso a uma filial ativa. Peça ao responsável pela conta para liberar o acesso."
        action={<ActionButton onClick={() => void sessionStore.logout()}>Sair</ActionButton>}
      />
    </div>
  );
}

export default function Home() {
  return <SessionGate>{(session) => <RedirectToBranch branches={session.branches} />}</SessionGate>;
}
