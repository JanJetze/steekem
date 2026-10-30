import { execSync } from "node:child_process";
import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";

// Every build is stamped with the commit it came from, so a visitor can match
// the deployed site to a commit and to the GitHub Actions run that built it.
// In Actions the variables are set by the runner; locally we ask git, and a
// container without git (the dev image) gets "unknown".
function buildCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}
const buildCommitSha = buildCommit();
const buildRunUrl =
  process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

export default defineConfig({
  site: "https://steekem.com",
  integrations: [
    preact(),
    sitemap({
      filter: (page) => !page.includes("/preview/"),
    }),
  ],
  server: {
    host: true,
    port: 4321,
  },
  vite: {
    define: {
      __BUILD_COMMIT__: JSON.stringify(buildCommitSha),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __BUILD_RUN_URL__: JSON.stringify(buildRunUrl),
    },
    // Bind-mounts on macOS/Docker swallow inotify events. Poll instead so HMR
    // reliably picks up host-side edits.
    server: {
      watch: {
        usePolling: true,
        interval: 300,
      },
    },
  },
});
