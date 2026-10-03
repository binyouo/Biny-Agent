/** Native dlopen cannot read Electron's virtual ASAR filesystem. Keep this
 * process entry and its SDK packages in the signed physical unpacked tree. */
export function resolveCuaProcessEntry(entry: URL): URL {
  const physical = new URL(entry);
  physical.pathname = physical.pathname.replace(/\/app\.asar\//, "/app.asar.unpacked/");
  return physical;
}
