import { wgslFn } from "three/tsl";
import type { Node } from "three/webgpu";

/** Whatever the node graph can hand to a WGSL entry point's parameters. */
export type ShaderInputs = Record<string, Node | number>;

/**
 * Binds a raw `.wgsl` source to the node graph as a callable shader function.
 *
 * three parses the entry point from the very start of the source, so the file
 * header is stripped first. Everything after that first `fn` — helper
 * functions, structs, consts — is emitted verbatim, and WGSL resolves
 * module-scope names in any order.
 */
export function shader<T extends ShaderInputs>(source: string) {
  return wgslFn<T>(source.slice(source.search(/^fn\s/m)));
}
