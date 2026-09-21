const catalogModules = import.meta.glob('../../../languages/*.json', {
  eager: true,
  import: 'default',
});

export const bundledLanguageCatalogs = Object.fromEntries(
  Object.entries(catalogModules).flatMap(([filePath, catalog]) => {
    const fileName = filePath.split('/').pop();
    const languageTag = fileName?.replace(/\.json$/, '');
    return languageTag && languageTag !== 'catalog.schema' ? [[languageTag, catalog]] : [];
  }),
);
