import initJolt from "jolt-physics";

/**
 * The instantiated Jolt WASM module. Every Jolt class hangs off this object
 * rather than off the import, because emscripten binds classes onto the module
 * instance at instantiation time.
 */
export type JoltModule = Awaited<ReturnType<typeof initJolt>>;

let pending: Promise<JoltModule> | null = null;

/**
 * Instantiates Jolt once per page.
 *
 * The `wasm-compat` build carries its own WASM payload base64-encoded inside
 * the bundle, so there is no side-car `.wasm` to serve, no `locateFile` hook,
 * and no second network round trip before physics can start.
 */
export function loadJolt(): Promise<JoltModule> {
  pending ??= initJolt();

  return pending;
}
