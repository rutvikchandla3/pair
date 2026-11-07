// The compute driver contract image's entrypoint: does what pair-bootstrap and the runner do
// that the contract suite can observe (computeDriverContract.ts, StandInRunnerHello).
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

const ENV_FILE = "/etc/pair-runner/bootstrap.env";
const GENERATION_FILE = "/etc/pair-runner/generation";

// The driver writes `NAME='value'` lines for `sh` to source; `'\''` is an embedded quote.
const parseBootstrap = (text) => {
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)='(.*)'$/.exec(line);
    if (match) values[match[1]] = match[2].replaceAll("'\\''", "'");
  }
  return values;
};

const readOrNull = (path) =>
  NodeFSP.readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

const bootstrapText = await readOrNull(ENV_FILE);
if (bootstrapText === null) {
  console.error("stand-in runner: no bootstrap");
  process.exit(1);
}
await NodeFSP.rm(ENV_FILE, { force: true });
const bootstrap = parseBootstrap(bootstrapText);
const generation = Number((await NodeFSP.readFile(GENERATION_FILE, "utf8")).trim());
const sandboxId = bootstrap.PAIR_SANDBOX_ID;
const serverUrl = bootstrap.PAIR_RUNNER_URL;

const request = (method, path, body) =>
  new Promise((resolve, reject) => {
    const target = serverUrl.startsWith("unix:")
      ? { socketPath: serverUrl.slice("unix:".length), path }
      : (() => {
          const url = new URL(path, serverUrl);
          return { host: url.hostname, port: url.port, path: url.pathname };
        })();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = NodeHttp.request(
      {
        ...target,
        method,
        headers: payload === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

// Written before the hello, so a stop right after it cannot lose the write.
const markerPath = `/t3-sandbox/${sandboxId}/contract-marker`;
const marker = await readOrNull(markerPath);
await NodeFSP.writeFile(markerPath, `g${generation}`);

const hello = await request("POST", "/hello", {
  sandboxId,
  generation,
  enroll: bootstrap.PAIR_RUNNER_ENROLL,
  marker,
});
if (hello.status !== 204) console.error(`stand-in runner: hello answered ${hello.status}`);

// Optional: a server that answers GET /probes learns which TCP targets this sandbox reaches.
const connects = (host, port) =>
  new Promise((resolve) => {
    const socket = NodeNet.connect({ host, port, timeout: 3000 });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
const probes = await request("GET", "/probes");
if (probes.status === 200) {
  const targets = JSON.parse(probes.text);
  const results = await Promise.all(
    targets.map(async ({ host, port }) => ({ host, port, ok: await connects(host, port) })),
  );
  await request("POST", "/probes", { sandboxId, generation, results });
}

process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
