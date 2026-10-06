import { isCheckGroupId } from '../../services/catalog-check';
import type { CatalogGroup } from './catalog-types';

export interface CatalogSelection {
  ids: readonly string[];
  disabled: boolean;
  toggle: (id: string) => void;
}
export function CatalogSelectionInput({
  group,
  selection,
}: {
  group: CatalogGroup;
  selection: CatalogSelection;
}) {
  const eligible = isCheckGroupId(group.id);
  return (
    <label className="mb-2 flex items-start gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        className="mt-0.5"
        aria-label={`选择变体组 ${
          group.name || '未命名变体组'
        }，ID ${JSON.stringify(group.id)}`}
        checked={selection.ids.includes(group.id)}
        disabled={selection.disabled || !eligible}
        onChange={() => selection.toggle(group.id)}
      />
      <span>{eligible ? '选择此组' : 'ID 不兼容批量接口，请先核实记录。'}</span>
    </label>
  );
}
