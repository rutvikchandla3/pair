import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isGlobalProcessObject, unwrapExpression } from "../utils.ts";

const HOST_MODULES = new Set([
  "node:child_process",
  "child_process",
  "node:fs",
  "fs",
  "node:fs/promises",
  "fs/promises",
  "node-pty",
]);
const HOST_PROCESS_MODULE = "@t3tools/shared/HostProcess";
const HOST_PROCESS_FACTS = new Set(["Platform", "HomeDirectory", "Environment", "isWindows"]);
const SERVICE_MESSAGES = new Map([
  [
    "ChildProcessSpawner",
    "Use `host.spawner` / `host.pty` from `WorkspaceHosts.forPath(cwd)` instead of ChildProcessSpawner.",
  ],
  [
    "PtyAdapter",
    "Use `host.spawner` / `host.pty` from `WorkspaceHosts.forPath(cwd)` instead of PtyAdapter.",
  ],
  [
    "FileSystem",
    "Use `host.fileSystem` from `WorkspaceHosts.forPath(cwd)`, or disable with a reason starting `server-scoped:`.",
  ],
]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep thread-scoped code from reaching the machine directly; go through WorkspaceHosts.forPath(cwd).",
    },
    schema: [],
  },
  createOnce(context) {
    const hostProcessNamespaces = new Set<string>();

    return {
      before() {
        hostProcessNamespaces.clear();
      },
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const source = node.source.value;
        if (source === HOST_PROCESS_MODULE) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportNamespaceSpecifier") {
              hostProcessNamespaces.add(specifier.local.name);
            }
          }
          return;
        }
        if (!HOST_MODULES.has(source)) return;
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every(
            (specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type",
          )
        ) {
          return;
        }
        context.report({
          node,
          message: `Do not import ${source} here. Reach the thread's machine through \`WorkspaceHosts.forPath(cwd)\`.`,
        });
      },
      MemberExpression(node) {
        const property = getPropertyName(node.property);
        if (Option.isNone(property)) return;
        const object = unwrapExpression(node.object);

        if (property.value === "env" && isGlobalProcessObject(node.object)) {
          context.report({
            node,
            message: "Take the base environment from `host.info.environment`, not process.env.",
          });
          return;
        }

        if (Option.isNone(object) || object.value.type !== "Identifier") return;
        const objectName = object.value.name;

        if (hostProcessNamespaces.has(objectName) && HOST_PROCESS_FACTS.has(property.value)) {
          context.report({
            node,
            message: `Read host facts from \`host.info\` in thread-scoped code, not HostProcess.${property.value}.`,
          });
          return;
        }

        const serviceMessage = SERVICE_MESSAGES.get(property.value);
        if (serviceMessage !== undefined && objectName === property.value) {
          context.report({ node, message: serviceMessage });
        }
      },
    };
  },
});
