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
 *
 * The entry point's parameter list must carry no `//` comments: three re-emits
 * it as `fn name ( <params> )` on one line, so a comment on the last parameter
 * eats the closing bracket and the compiler complains about the first line of
 * the body instead. Document parameters above the function.
 *
 * `TOut` names the entry point's WGSL return type. three's own typings hand
 * back an untyped node, which is fine to plug straight into the graph but
 * cannot be swizzled; declaring it here lets a caller take `.xy` off a `vec4f`
 * result and still be checked.
 */
export function shader<T extends ShaderInputs, TOut = unknown>(source: string) {
  const bound = wgslFn<T>(source.slice(source.search(/^fn\s/m)));

  return bound as unknown as (...params: Parameters<typeof bound>) => Node<TOut>;
}
