/**
 * Local test/runner resolver for Node's native TypeScript stripping mode.
 *
 * Production TypeScript intentionally uses NodeNext `.js` specifiers.  Node
 * resolves those after compilation, while source-mode tests need the matching
 * `.ts` source file.  This loader only retries relative `.js` imports as
 * `.ts`; packages and non-relative URLs are delegated unchanged.
 */
export async function resolve(specifier, context, nextResolve) {
  const isRelativeJavaScript =
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js");

  if (isRelativeJavaScript) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  return nextResolve(specifier, context);
}
