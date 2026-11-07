// @effect-diagnostics nodeBuiltinImport:off -- the test's own temp root.
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChatAttachmentId, ChatFileAttachment, ChatImageAttachment } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { SANDBOX_ROOT, type WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHostLoopback from "../../workspaceHost/WorkspaceHostLoopback.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as SandboxAttachments from "./SandboxAttachments.ts";

const root = NodeOS.tmpdir();
const layerTest = SandboxAttachments.layer.pipe(
  Layer.provideMerge(WorkspaceHostLoopback.layerLoopback(root)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sandbox-attachments-" })),
  Layer.provideMerge(NodeServices.layer),
);

const image = ChatImageAttachment.make({
  type: "image",
  id: ChatAttachmentId.make("thread-sandbox-staging-12345678-1234-1234-1234-123456789abc"),
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 4,
});
const document = ChatFileAttachment.make({
  type: "file",
  id: ChatAttachmentId.make("thread-sandbox-staging-abcdefab-1234-1234-1234-123456789abc"),
  name: "requirements.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 4,
});
const lost = ChatImageAttachment.make({
  ...image,
  id: ChatAttachmentId.make("thread-sandbox-staging-00000000-1234-1234-1234-123456789abc"),
});
const SEGMENT = "thread-sandbox-staging";

/** The runner serves the local disk, so the test maps the reserved root to a temp folder it can read. */
const withSandboxDisk = Effect.fn("SandboxAttachments.test.withSandboxDisk")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const { sandboxId } = yield* WorkspaceHostLoopback.LoopbackRunner;
  const disk = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sandbox-disk-" });
  const cwd = `${root}/t3-sandbox-attachments-cwd/worktrees/a`;
  const host = yield* hosts.forPath(root);
  const toDisk = (path: string) => path.replace(SANDBOX_ROOT, disk);
  const writes: Array<string> = [];
  const sandbox: WorkspaceHost = {
    ...host,
    fileSystem: {
      ...host.fileSystem,
      makeDirectory: (path, options) => host.fileSystem.makeDirectory(toDisk(path), options),
      stat: (path) => host.fileSystem.stat(toDisk(path)),
      writeFile: (path, data, options) => {
        writes.push(path);
        return host.fileSystem.writeFile(toDisk(path), data, options);
      },
    },
  };
  yield* hosts.register(`${root}/t3-sandbox-attachments-cwd`, sandbox);
  return { cwd, sandboxId, toDisk, writes };
});

it.layer(layerTest)("SandboxAttachmentStaging", (it) => {
  it.effect("copies attachments and their extracted text under the sandbox root, once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const staging = yield* SandboxAttachments.SandboxAttachmentStaging;
      const { cwd, sandboxId, toDisk, writes } = yield* withSandboxDisk();
      const imagePath = path.join(attachmentsDir, attachmentRelativePath(image)!);
      const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
      yield* fileSystem.writeFile(imagePath, Uint8Array.from([1, 2, 3, 4]));
      yield* fileSystem.writeFile(documentPath, Uint8Array.from([5, 6, 7, 8]));
      yield* fileSystem.writeFileString(`${documentPath}.txt`, "extracted");

      yield* staging.stage({ cwd, attachments: [image, document] });

      const folder = `${SANDBOX_ROOT}/${sandboxId}/attachments/${SEGMENT}`;
      const staged = [
        `${folder}/${attachmentRelativePath(image)}`,
        `${folder}/${attachmentRelativePath(document)}`,
        `${folder}/${attachmentRelativePath(document)}.txt`,
      ];
      assert.deepEqual(staged[0], SandboxAttachments.sandboxAttachmentPath(sandboxId, image));
      assert.deepEqual([...writes].toSorted(), [...staged].toSorted());
      assert.deepEqual(Array.from(yield* fileSystem.readFile(toDisk(staged[1]!))), [5, 6, 7, 8]);
      assert.equal(yield* fileSystem.readFileString(toDisk(staged[2]!)), "extracted");
      // The agent user is another user: it needs the other-read and other-execute bits.
      assert.equal((yield* fileSystem.stat(toDisk(staged[0]!))).mode & 0o004, 0o004);
      assert.equal((yield* fileSystem.stat(toDisk(folder))).mode & 0o005, 0o005);

      yield* staging.stage({ cwd, attachments: [image, document] });
      assert.equal(writes.length, 3);

      // Changed bytes make a new size: only that file copies again.
      yield* fileSystem.writeFile(imagePath, Uint8Array.from([1, 2, 3, 4, 5]));
      yield* staging.stage({ cwd, attachments: [image, document] });
      assert.deepEqual(writes.slice(3), [staged[0]]);
      assert.equal((yield* fileSystem.readFile(toDisk(staged[0]!))).length, 5);
    }),
  );

  it.effect("stages nothing for a local cwd, no cwd or a file the server lost", () =>
    Effect.gen(function* () {
      const staging = yield* SandboxAttachments.SandboxAttachmentStaging;
      const { cwd, writes } = yield* withSandboxDisk();
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      yield* (yield* FileSystem.FileSystem).writeFile(
        (yield* Path.Path).join(attachmentsDir, attachmentRelativePath(image)!),
        Uint8Array.from([1, 2, 3, 4]),
      );
      yield* staging.stage({ cwd: null, attachments: [image] });
      yield* staging.stage({ cwd: NodeOS.homedir(), attachments: [image] });
      yield* staging.stage({ cwd, attachments: [] });
      yield* staging.stage({ cwd, attachments: [lost] });
      assert.deepEqual(writes, []);
    }),
  );
});
