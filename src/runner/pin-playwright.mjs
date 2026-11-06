// Loaded into every `playwright test` process with --import. Specs in a project
// import "@playwright/test" and Node would look for it in that project's
// node_modules: on the mounted repo that is a different version, or nothing.
// Two copies in one run is a hard Playwright error, and a different version
// makes results incomparable, so these three names always mean this image's copy.
import { registerHooks } from "node:module";

const IMAGE_MODULES = new URL("../../node_modules/", import.meta.url).href;
const PINNED = /^(@playwright\/test|playwright|playwright-core)(\/|$)/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (PINNED.test(specifier)) return nextResolve(specifier, { ...context, parentURL: IMAGE_MODULES });
    return nextResolve(specifier, context);
  },
});
