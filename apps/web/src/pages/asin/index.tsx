import { CatalogPage } from '../catalog';
import { LinkedGroupPanel } from '../home/linked-group-panel';
import { AsinImportPanel } from './asin-import-panel';
import { ASIN_CATALOG } from './config';

export default function AsinCatalogPage({ groupId }: { groupId?: string }) {
  return (
    <CatalogPage
      config={ASIN_CATALOG}
      extra={
        <>
          <LinkedGroupPanel id={groupId} />
          <AsinImportPanel />
        </>
      }
    />
  );
}
