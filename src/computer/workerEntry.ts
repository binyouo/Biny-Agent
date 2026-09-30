/** Native dlopen cannot read Electron's virtual ASAR filesystem. Keep this
 * worker and its optional SDK packages in the signed physical unpacked tree. */
export function resolveCuaWorkerEntry(entry: URL): URL {
  const physical = new URL(entry);
  physical.pathname = physical.pathname.replace(/\/app\.asar\//, "/app.asar.unpacked/");
  return physical;
}
