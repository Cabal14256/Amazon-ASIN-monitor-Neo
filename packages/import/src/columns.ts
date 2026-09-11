export interface ImportColumns {
  groupNameIndex: number;
  countryIndex: number;
  siteIndex: number;
  brandIndex: number;
  asinIndex: number;
  asinNameIndex: number;
  asinTypeIndex: number;
}

/** Preserve existing exported templates and historical spreadsheet header repair. */
export function repairImportHeader(value: unknown): string {
  let header = String(value || '').trim();
  if (header.includes('±ä') || header.includes('Ìå') || header.includes('×é'))
    header = Buffer.from(header, 'latin1').toString('utf8');
  return header;
}

/** Ordered Legacy rules. Call after determining the worksheet's maximum width:
 * its trailing empty header cells affect the historical ASIN-type fallback. */
export function findImportColumns(headers: string[]): ImportColumns {
  const exactGroupNameIndex = headers.findIndex((header) => {
    const lower = header.toLowerCase();
    return (
      header.includes('变体组') ||
      header.includes('组名称') ||
      header === '变体组名称' ||
      lower.includes('group') ||
      lower.includes('variant')
    );
  });
  const groupNameIndex =
    exactGroupNameIndex !== -1
      ? exactGroupNameIndex
      : headers.findIndex(
          (header, index) =>
            header.includes('变体') ||
            header.includes('组') ||
            (index === 0 && header.length > 0),
        );
  const exactCountryIndex = headers.findIndex(
    (header) =>
      header.includes('国家') ||
      header === '国家' ||
      header.toLowerCase() === 'country',
  );
  const countryIndex =
    exactCountryIndex !== -1
      ? exactCountryIndex
      : headers.findIndex(
          (header, index) =>
            header.includes('国') ||
            header.toLowerCase().includes('country') ||
            (index === 1 && header.length > 0 && header.length < 10),
        );
  const exactSiteIndex = headers.findIndex(
    (header) =>
      header.includes('站点') ||
      header === '站点' ||
      header.toLowerCase() === 'site',
  );
  const siteIndex =
    exactSiteIndex !== -1
      ? exactSiteIndex
      : headers.findIndex(
          (header, index) =>
            header.includes('站') ||
            header.toLowerCase().includes('site') ||
            (index === 2 && header.length > 0 && header.length < 20),
        );
  const exactBrandIndex = headers.findIndex(
    (header) =>
      header.includes('品牌') ||
      header === '品牌' ||
      header.toLowerCase() === 'brand',
  );
  const brandIndex =
    exactBrandIndex !== -1
      ? exactBrandIndex
      : headers.findIndex(
          (header, index) =>
            header.includes('品') ||
            header.toLowerCase().includes('brand') ||
            (index === 3 && header.length > 0 && header.length < 50),
        );
  const exactAsinIndex = headers.findIndex(
    (header) => header === 'ASIN' || header.toLowerCase() === 'asin',
  );
  const asinIndex =
    exactAsinIndex !== -1
      ? exactAsinIndex
      : headers.findIndex((header, index) => {
          const lower = header.toLowerCase();
          const isAsinLike = header.includes('ASIN') || lower.includes('asin');
          const related =
            header.includes('类型') ||
            header.includes('名称') ||
            lower.includes('type') ||
            lower.includes('name');
          return (
            (isAsinLike && !related) ||
            (index >= 4 && header.length > 0 && /^[A-Z0-9]+$/i.test(header))
          );
        });
  const asinNameIndex = headers.findIndex((header) => {
    const lower = header.toLowerCase();
    return (
      (header.includes('名称') && header.includes('ASIN')) ||
      header === 'ASIN名称' ||
      (header.includes('名称') &&
        !header.includes('组') &&
        !header.includes('变体组')) ||
      (lower.includes('asin') && lower.includes('name')) ||
      (lower.includes('name') &&
        !lower.includes('group') &&
        !lower.includes('variant'))
    );
  });
  const asinTypeIndex = headers.findIndex((header, index) => {
    const lower = header.toLowerCase();
    return (
      (header.includes('类型') && header.includes('ASIN')) ||
      header === 'ASIN类型' ||
      (header.includes('类型') &&
        !header.includes('组') &&
        !header.includes('变体组')) ||
      (lower.includes('asin') && lower.includes('type')) ||
      (lower.includes('type') && !lower.includes('variant')) ||
      (asinIndex !== -1 && index > asinIndex && index >= headers.length - 2)
    );
  });
  return {
    groupNameIndex,
    countryIndex,
    siteIndex,
    brandIndex,
    asinIndex,
    asinNameIndex,
    asinTypeIndex,
  };
}

export function missingImportColumns(indexes: ImportColumns): string[] {
  const result: string[] = [];
  if (indexes.groupNameIndex === -1) result.push('变体组名称');
  if (indexes.countryIndex === -1) result.push('国家');
  if (indexes.asinIndex === -1) result.push('ASIN');
  if (indexes.brandIndex === -1) result.push('品牌');
  if (indexes.siteIndex === -1) result.push('站点');
  return result;
}
