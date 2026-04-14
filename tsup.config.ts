import {defineConfig} from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        "check-auth-quota": "src/check-auth-quota.ts",
        "batch-register": "src/batch-register.ts",
    },
    outDir: "bundle",
    format: ["cjs"],
    target: "node20",
    platform: "node",
    splitting: false,
    sourcemap: false,
    clean: true,
    dts: false,
    noExternal: [
        "fetch-cookie",
        "tough-cookie",
        "undici",
        "socks",
    ],
    external: [
        "playwright-core",
        "chromium-bidi",
    ],
    outExtension() {
        return {
            js: ".cjs",
        };
    },
});
