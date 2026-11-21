import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const testExportsOptions = {
  entryPoints: ["src/test-exports.ts"],
  bundle: true,
  outfile: "dist/test-exports.mjs",
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  minify: false,
};

if (watch) {
  const ctx = await esbuild.context(extensionOptions);
  await ctx.watch();
  console.log("Watching...");
} else {
  await esbuild.build(extensionOptions);
  if (!production) {
    await esbuild.build(testExportsOptions);
  }
  console.log("Build complete.");
}
