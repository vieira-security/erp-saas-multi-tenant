import Link from "next/link";
import { branchPath } from "../lib/navigation/branch-route";
import type { NavItem } from "../lib/navigation/nav-items";

/** Menu lateral: recebe só os itens já filtrados por permissão (`visibleNavItems`). */
export function SideNav({
  items,
  branchId,
  activeSegment,
  onNavigate,
}: {
  readonly items: readonly NavItem[];
  readonly branchId: string;
  readonly activeSegment: string;
  readonly onNavigate?: () => void;
}) {
  const groups = [...new Set(items.map((item) => item.group))];
  return (
    <nav aria-label="Menu principal" className="flex flex-col gap-6 p-3">
      {groups.map((group) => (
        <div key={group}>
          <p className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{group}</p>
          <ul className="flex flex-col gap-0.5">
            {items
              .filter((item) => item.group === group)
              .map((item) => {
                const active = item.segment === activeSegment;
                return (
                  <li key={item.id}>
                    <Link
                      href={branchPath(branchId, item.segment)}
                      {...(onNavigate ? { onClick: onNavigate } : {})}
                      {...(active ? { "aria-current": "page" as const } : {})}
                      className={`block rounded-md px-3 py-2 text-sm ${
                        active ? "bg-primary-soft font-medium text-primary" : "text-foreground hover:bg-surface-muted"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
