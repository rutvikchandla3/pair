import { expect, it } from "@effect/vitest";
import type * as SchemaAST from "effect/SchemaAST";
import { WsRpcGroup } from "./rpc.ts";
import { RPC_THREAD_TARGET_EXEMPT, RPC_THREAD_TARGETS } from "./rpcThreadTargets.ts";

const TARGET_FIELD =
  /^(threadIds?|sandboxIds?|cwd|paths?|root)$|(ThreadIds?|SandboxIds?|Path|Paths|Root)$/;

const targetFields = (
  ast: SchemaAST.AST,
  prefix = "",
  seen = new Set<SchemaAST.AST>(),
): ReadonlyArray<string> => {
  if (seen.has(ast)) return [];
  seen.add(ast);
  switch (ast._tag) {
    case "Objects":
      return [
        ...ast.propertySignatures.flatMap((property) => {
          const path = `${prefix}.${String(property.name)}`;
          return [
            ...(TARGET_FIELD.test(String(property.name)) ? [path] : []),
            ...targetFields(property.type, path, seen),
          ];
        }),
        ...ast.indexSignatures.flatMap((index) => targetFields(index.type, `${prefix}[]`, seen)),
      ];
    case "Union":
      return ast.types.flatMap((member) => targetFields(member, prefix, seen));
    case "Arrays":
      return [...ast.elements, ...ast.rest].flatMap((element) =>
        targetFields(element, `${prefix}[]`, seen),
      );
    case "Suspend":
      return targetFields(ast.thunk(), prefix, seen);
    case "Declaration":
      return ast.typeParameters.flatMap((parameter) => targetFields(parameter, prefix, seen));
    default:
      return [];
  }
};

const matched = [...WsRpcGroup.requests.values()].flatMap((rpc) => {
  const fields = [...new Set(targetFields(rpc.payloadSchema.ast))];
  return fields.length === 0 ? [] : [{ method: rpc._tag, fields }];
});

it("names every RPC whose input points at a thread, a machine or a path", () => {
  const unguarded = matched.filter(
    ({ method }) => !(method in RPC_THREAD_TARGETS) && !(method in RPC_THREAD_TARGET_EXEMPT),
  );
  expect(unguarded).toEqual([]);
  // The walk must see through classes, unions and arrays, or it proves nothing.
  expect(matched.find(({ method }) => method === "terminal.open")?.fields).toContain(".threadId");
  expect(matched.find(({ method }) => method === "assets.createUrl")?.fields).toContain(
    ".resource.cwd",
  );
  expect(matched.find(({ method }) => method === "filesystem.getMetadata")?.fields).toContain(
    ".paths",
  );
});

it("keeps the table and the exemptions to methods that name something", () => {
  const named = new Set<string>(matched.map(({ method }) => method));
  const listed = [...Object.keys(RPC_THREAD_TARGETS), ...Object.keys(RPC_THREAD_TARGET_EXEMPT)];
  expect(listed.filter((method) => !named.has(method))).toEqual([]);
  expect(
    Object.keys(RPC_THREAD_TARGETS).filter((method) => method in RPC_THREAD_TARGET_EXEMPT),
  ).toEqual([]);
});
