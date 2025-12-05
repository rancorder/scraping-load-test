import http from "k6/http";
import { check, sleep } from "k6";
export const options = {
  scenarios: {
    test: {
      executor: "ramping-vus",
      startVUs: 10,
      stages: [
        { duration: "30s", target: 43 },
        { duration: "30s", target: 60 },
        { duration: "30s", target: 43 },
      ],
    },
  },
};
const BASE = "http://host.docker.internal:8002";
const SITES = Array.from({length: 100}, (_, i) => ({ id: "site_" + i, pw: i < 40 }));
export default function () {
  const s = SITES[(__VU - 1) % SITES.length];
  const r = http.post(BASE + "/api/scrape/" + s.id + "?use_playwright=" + s.pw, null, { timeout: "20s" });
  check(r, { "ok": (x) => x.status === 200 });
  sleep(s.pw ? 60 : 40);
}
