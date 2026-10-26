import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("packageRegistryNpm", {
  env: {
    /** The registry to act on; https://registry.npmjs.org when absent. */
    NPM_REGISTRY_URL: v.optional(v.string()),
  },
});
