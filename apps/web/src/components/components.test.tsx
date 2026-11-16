import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MOCK_BRANCH_CENTRO, MOCK_BRANCH_SHOPPING, mockMe } from "../lib/api/mocks/data";
import { operableBranches } from "../lib/api/mocks/mock-fetch";
import { visibleNavItems } from "../lib/navigation/nav-items";
import { AppShell } from "./app-shell";
import { BranchSelector } from "./branch-selector";
import { SideNav } from "./side-nav";
import { ErrorState, ForbiddenState, LoadingState, SessionExpiredState } from "./states";

const me = mockMe("mixed");
const branches = operableBranches(me);

describe("BranchSelector", () => {
  it("lists /me/branches and marks the branch from the route", () => {
    const html = renderToStaticMarkup(<BranchSelector branches={branches} value={MOCK_BRANCH_SHOPPING.id} onSelect={vi.fn()} />);
    expect(html).toContain('aria-label="Filial atual"');
    expect(html).toContain("Centro (CENTRO)");
    expect(html).toContain("Shopping Norte (SHOPPING)");
    expect(html).toMatch(new RegExp(`<option value="${MOCK_BRANCH_SHOPPING.id}" selected="">`));
    expect(html).not.toContain("ANTIGA");
  });

  it("calls onSelect with the chosen branch id", () => {
    const onSelect = vi.fn();
    const element = BranchSelector({ branches, value: MOCK_BRANCH_CENTRO.id, onSelect });
    const select = (element.props as { children: [unknown, { props: { onChange: (e: unknown) => void } }] }).children[1];
    select.props.onChange({ target: { value: MOCK_BRANCH_SHOPPING.id } });
    expect(onSelect).toHaveBeenCalledWith(MOCK_BRANCH_SHOPPING.id);
  });

  it("is disabled with a single branch", () => {
    const html = renderToStaticMarkup(<BranchSelector branches={branches.slice(0, 1)} value={MOCK_BRANCH_CENTRO.id} onSelect={vi.fn()} />);
    expect(html).toContain("disabled");
  });
});

describe("SideNav", () => {
  it("renders only permitted items, with branch-scoped links", () => {
    const html = renderToStaticMarkup(
      <SideNav items={visibleNavItems(me, MOCK_BRANCH_CENTRO.id)} branchId={MOCK_BRANCH_CENTRO.id} activeSegment="orders" />,
    );
    expect(html).toContain(`href="/branches/${MOCK_BRANCH_CENTRO.id}/orders"`);
    expect(html).toContain(`href="/branches/${MOCK_BRANCH_CENTRO.id}/admin/branches"`);
    expect(html).not.toContain("Usuários");
    expect(html).not.toContain("Empresas");
    expect(html).not.toContain("Ajustes do cardápio");
    expect(html).toMatch(/aria-current="page"[^>]*>Pedidos</);
  });

  it("shows the branch-level item in the branch where it is granted", () => {
    const html = renderToStaticMarkup(
      <SideNav items={visibleNavItems(me, MOCK_BRANCH_SHOPPING.id)} branchId={MOCK_BRANCH_SHOPPING.id} activeSegment="" />,
    );
    expect(html).toContain("Ajustes do cardápio");
  });
});

describe("AppShell and states", () => {
  it("renders header, selector, menu and content", () => {
    const html = renderToStaticMarkup(
      <AppShell
        me={me}
        branches={branches}
        branchId={MOCK_BRANCH_CENTRO.id}
        navItems={visibleNavItems(me, MOCK_BRANCH_CENTRO.id)}
        activeSegment=""
        onSelectBranch={vi.fn()}
        onLogout={vi.fn()}
      >
        <p>conteúdo</p>
      </AppShell>,
    );
    expect(html).toContain("Restaurante Demo");
    expect(html).toContain("Ana Souza");
    expect(html).toContain('aria-label="Menu principal"');
    expect(html).toContain("<p>conteúdo</p>");
    expect(html).toContain("Sair");
  });

  it("states show stable messages, never server details", () => {
    expect(renderToStaticMarkup(<LoadingState />)).toContain("Carregando");
    expect(renderToStaticMarkup(<ForbiddenState />)).toContain("Sem permissão");
    expect(renderToStaticMarkup(<SessionExpiredState onRetry={vi.fn()} />)).toContain("Sessão encerrada");
    const error = renderToStaticMarkup(<ErrorState code="network_error" onRetry={vi.fn()} />);
    expect(error).toContain('role="alert"');
    expect(error).toContain("Tentar de novo");
  });
});
