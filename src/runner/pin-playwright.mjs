// Loaded into every `playwright test` process with --import. Specs in a project
// import "@playwright/test" and Node would look for it in that project's
// node_modules: on the mounted repo that is a different version, or nothing.
// Two copies in one run is a hard Playwright error, and a different version
// makes results incomparable, so these three names always mean this image's copy.
// Imports from the image's own packages are left alone: they already find it.
import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const IMAGE_MODULES = new URL("../../node_modules/", import.meta.url).href;
// pnpm does not hoist playwright-core: only the playwright package can see it.
const PLAYWRIGHT_PACKAGE = pathToFileURL(realpathSync(new URL("playwright/package.json", IMAGE_MODULES))).href;
const PINNED = /^(@playwright\/test|playwright|playwright-core)(\/|$)/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const pinned = PINNED.exec(specifier);
    if (!pinned || context.parentURL?.startsWith(IMAGE_MODULES)) return nextResolve(specifier, context);
    const parentURL = pinned[1] === "playwright-core" ? PLAYWRIGHT_PACKAGE : IMAGE_MODULES;
    // require() ignores a changed parentURL, so there the hook names the file itself.
    if (context.conditions?.includes("require")) return nextResolve(createRequire(parentURL).resolve(specifier), context);
    return nextResolve(specifier, { ...context, parentURL });
  },
});
