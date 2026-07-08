import { createBaseConfig } from "../../eslint.base.config.js";

export default [
  // Ignores for frontend
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.config.js",
      "*.config.ts",
      "*.config.d.ts",
      "coverage/**",
      "public/**",
      "**/*.d.ts",
      "**/recharts/**",
      "**/react-qr-code/**",
      "src/lib/recharts-patch.ts",
      "src/lib/react-qr-code-patch.ts",
    ],
  },

  // Use base config for frontend app
  ...createBaseConfig({
    includeReact: true,
    includeTanstackQuery: true,
    includeReactRefresh: true,
    tsconfigPath: ["./tsconfig.json", "./tsconfig.node.json"],
  }),

  // Keep the web and shared adapters platform-neutral: Tauri APIs are
  // desktop-only and must never be statically imported here, or they would be
  // pulled into the web bundle. Desktop code belongs in src/adapters/tauri/**.
  {
    files: ["src/adapters/shared/**/*.{ts,tsx}", "src/adapters/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*", "tauri-plugin-*"],
              message:
                "Tauri APIs are desktop-only and would ship in the web bundle. Put desktop code in src/adapters/tauri/** instead.",
            },
          ],
        },
      ],
    },
  },
];
