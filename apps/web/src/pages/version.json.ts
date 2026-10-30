import type { APIRoute } from "astro";

const REPO = "https://github.com/JanJetze/steekem";

/** Which build is serving this site. Prerendered, so it describes the deployed
 *  bundle itself; compare it with the commit on GitHub and with the Actions
 *  run that produced it. */
export const GET: APIRoute = () => {
  const commit = __BUILD_COMMIT__;
  const body = {
    commit,
    builtAt: __BUILD_TIME__,
    source: commit === "unknown" ? null : `${REPO}/commit/${commit}`,
    build: __BUILD_RUN_URL__,
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
