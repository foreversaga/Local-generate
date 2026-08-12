/**
 * Small dependency-injected dispatcher for domain HTTP routers.  Matching and
 * handling are separate so each domain can be tested without booting Vinext.
 */
export function createDomainRouter(definitions = []) {
  if (!Array.isArray(definitions)) throw new TypeError("Domain routes must be an array.");
  const routes = definitions.map((definition, index) => {
    if (!definition || typeof definition.matches !== "function" || typeof definition.handle !== "function") {
      throw new TypeError(`Domain route ${index} must define matches and handle functions.`);
    }
    return {
      name: String(definition.name || `route-${index + 1}`),
      matches: definition.matches,
      handle: definition.handle,
    };
  });

  return {
    names: routes.map(({ name }) => name),
    async dispatch(context) {
      for (const route of routes) {
        if (!(await route.matches(context))) continue;
        const handled = await route.handle(context);
        if (handled || context?.res?.headersSent) return true;
      }
      return false;
    },
  };
}
