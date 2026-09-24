/**
 * Build-time distribution flag.
 *
 * The two distributions are DIFFERENT FILES built from this same source tree:
 *   dist/index.js         (tsc)     -> MCPB / Claude Desktop, manual stdio
 *   dist/plugin-server.js (esbuild) -> Codex plugin, installed from the marketplace
 *
 * Only the esbuild bundle defines __MEGA_PLUGIN_BUILD__ (see
 * scripts/plugin-bundle-options.mjs), so anything gated on this constant is
 * compiled into the Codex bundle ALONE and cannot change what an existing
 * Claude Desktop install does — there, the identifier is simply absent.
 *
 * Why a build flag rather than a runtime probe: the MCPB path already has a
 * first-class settings UI for file reading (manifest user_config -> a checkbox),
 * so the in-conversation prompt would be a redundant second way to say the same
 * thing. The Codex plugin format has no equivalent — user config cannot set a
 * plugin-provided server's env at all — which is the whole reason the prompt
 * exists. The `typeof` guard is what keeps the tsc build from throwing on an
 * identifier that was never substituted.
 */
declare const __MEGA_PLUGIN_BUILD__: boolean | undefined;

export const isPluginBuild: boolean = typeof __MEGA_PLUGIN_BUILD__ !== 'undefined' && __MEGA_PLUGIN_BUILD__ === true;
