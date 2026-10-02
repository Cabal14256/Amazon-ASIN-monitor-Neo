import { CatalogPage } from '../catalog';
import { AsinImportPanel } from './asin-import-panel';
import { ASIN_CATALOG } from './config';

export default function AsinCatalogPage() {
  return <CatalogPage config={ASIN_CATALOG} extra={<AsinImportPanel />} />;
}
