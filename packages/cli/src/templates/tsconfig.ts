import { stringifyTabs } from "../lib/json-tabs.js";

export const tsconfigTemplate = (): string =>
	`${stringifyTabs({
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			lib: ["ES2023"],
			strict: true,
			noUncheckedIndexedAccess: true,
			declaration: true,
			sourceMap: true,
			esModuleInterop: true,
			skipLibCheck: true,
			forceConsistentCasingInFileNames: true,
			resolveJsonModule: true,
			isolatedModules: true,
			outDir: "./dist",
			rootDir: "./src",
		},
		include: ["src/**/*"],
		exclude: ["dist", "node_modules"],
	})}\n`;
