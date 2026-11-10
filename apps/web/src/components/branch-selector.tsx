import type { BranchSummaryDto } from "@erp/contracts";

/** Seletor da filial atual, alimentado por `GET /me/branches`. Trocar chama `onSelect`; quem usa decide a rota. */
export function BranchSelector({
  branches,
  value,
  onSelect,
}: {
  readonly branches: readonly BranchSummaryDto[];
  readonly value: string;
  readonly onSelect: (branchId: string) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="hidden text-muted sm:inline">Filial</span>
      <select
        aria-label="Filial atual"
        value={value}
        onChange={(event) => onSelect(event.target.value)}
        disabled={branches.length < 2}
        className="min-w-0 max-w-56 truncate rounded-md border border-line bg-surface px-2 py-1.5 font-medium disabled:opacity-100"
      >
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name} ({branch.code})
          </option>
        ))}
      </select>
    </label>
  );
}
