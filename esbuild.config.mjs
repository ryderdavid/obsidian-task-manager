import esbuild from "esbuild";
import process from "process";
import { execSync } from "child_process";

const prod = process.argv[2] === "production";

let gitBranch = "unknown";
try {
  gitBranch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
} catch {
  // Not in a git repo or git not available
}

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/language", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  sourcemap: prod ? false : "inline",
  minify: prod,
  logLevel: "info",
  define: {
    "__GIT_BRANCH__": JSON.stringify(gitBranch),
  },
}).catch(() => process.exit(1));
