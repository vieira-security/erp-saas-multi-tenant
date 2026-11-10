"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { branchPath } from "../lib/navigation/branch-route";
import { canSee, findNavItem, visibleNavItems } from "../lib/navigation/nav-items";
import { useSession } from "../lib/session/session";
import { EmptyState, ForbiddenState } from "./states";

/**
 * Conteúdo das telas do menu enquanto elas não existem (próximas branches). Item sem permissão = estado 403, mesmo
 * acessado pela URL: o menu só esconde, e a API recusaria de qualquer forma.
 */
export function SectionPage({ segment }: { readonly segment: string }) {
  const { branchId } = useParams<{ branchId: string }>();
  const session = useSession();
  if (session.status !== "authenticated") return null;

  const { me, branches } = session;
  const branch = branches.find((b) => b.id === branchId);
  const item = findNavItem(segment);

  if (!item) {
    return <EmptyState title="Página não encontrada" description="O endereço não corresponde a nenhuma tela." />;
  }
  if (!canSee(item, me, branchId)) {
    return <ForbiddenState />;
  }
  if (item.segment === "") {
    const shortcuts = visibleNavItems(me, branchId).filter((i) => i.segment !== "");
    return (
      <section className="flex flex-col gap-6">
        <header>
          <h1 className="text-xl font-semibold">Olá, {me.user.name.split(" ")[0]}</h1>
          <p className="text-sm text-muted">
            {me.organization.name} · {branch?.name} ({branch?.code})
          </p>
        </header>
        {shortcuts.length === 0 ? (
          <EmptyState title="Nada por aqui ainda" description="Seu acesso nesta filial não inclui nenhuma tela." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shortcuts.map((shortcut) => (
              <li key={shortcut.id}>
                <Link
                  href={branchPath(branchId, shortcut.segment)}
                  className="block rounded-lg border border-line bg-surface p-4 hover:border-primary"
                >
                  <span className="font-medium">{shortcut.label}</span>
                  <span className="block text-xs text-muted">{shortcut.group}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{item.label}</h1>
      <EmptyState title="Tela em construção" description="Esta área chega nas próximas entregas." />
    </section>
  );
}
