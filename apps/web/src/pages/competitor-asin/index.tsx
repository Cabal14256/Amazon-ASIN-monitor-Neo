import { AsinImportPanel } from '../asin/asin-import-panel';
import { CatalogPage } from '../catalog';
import { COMPETITOR_CATALOG } from './config';

export default function CompetitorAsinCatalogPage() {
  return (
    <CatalogPage
      config={COMPETITOR_CATALOG}
      extra={<AsinImportPanel domain="competitor" />}
    />
  );
}
