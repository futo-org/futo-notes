interface Route {
  path: string;
  pattern: RegExp;
  paramNames: string[];
  render: (params: Record<string, string>) => void;
}

const routes: Route[] = [];

function pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${pattern}$`), paramNames };
}

export const router = {
  register(path: string, render: (params: Record<string, string>) => void) {
    const { pattern, paramNames } = pathToRegex(path);
    routes.push({ path, pattern, paramNames, render });
  },

  navigate(path: string) {
    window.location.hash = `#${path}`;
  },

  start() {
    const handleRoute = () => {
      const hash = window.location.hash.slice(1) || '/';
      for (const route of routes) {
        const match = hash.match(route.pattern);
        if (match) {
          const params: Record<string, string> = {};
          route.paramNames.forEach((name, i) => {
            params[name] = decodeURIComponent(match[i + 1]);
          });
          route.render(params);
          return;
        }
      }
      // Fallback to home
      window.location.hash = '#/';
    };

    window.addEventListener('hashchange', handleRoute);
    handleRoute();
  }
};
