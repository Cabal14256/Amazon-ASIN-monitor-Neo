import { CatalogPage } from '../catalog';
import { ASIN_CATALOG } from './config';

export default function AsinCatalogPage() {
  return <CatalogPage config={ASIN_CATALOG} />;
}
