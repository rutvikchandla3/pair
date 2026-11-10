import { expect, it } from "@effect/vitest";
import * as RpcSchema from "effect/rpc/RpcSchema";
import type * as SchemaAST from "effect/SchemaAST";
import { RpcThreadAccess, WsRpcGroup } from "./rpc.ts";
import {
  RPC_OUTPUT_EXEMPT,
  RPC_OUTPUT_FILTERED,
  RPC_THREAD_TARGET_EXEMPT,
  RPC_THREAD_TARGETS,
} from "./rpcThreadTargets.ts";

const TARGET_FIELD =
  /^(threadIds?|sandboxIds?|cwd|paths?|root)$|(ThreadIds?|SandboxIds?|Path|Paths|Root)$/;

// Brands are type-only in Effect 4, so a `ThreadId` is found by its field's name and a `SandboxId`
// by its pattern check, which no other string carries.
const isSandboxId = (ast: SchemaAST.AST) =>
  ast._tag === "String" &&
  (ast.checks ?? []).some((check) =>
    String(JSON.stringify(check.annotations?.["representation"])).includes("^sbx_"),
  );

const targetFields = (
  ast: SchemaAST.AST,
  prefix = "",
  seen = new Set<SchemaAST.AST>(),
): ReadonlyArray<string> => {
  if (seen.has(ast)) return [];
  seen.add(ast);
  if (isSandboxId(ast)) return [`${prefix}:SandboxId`];
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
    case "Null":
    case "Undefined":
    case "Void":
    case "Never":
    case "Any":
    case "Unknown":
    case "ObjectKeyword":
    case "Enum":
    case "TemplateLiteral":
    case "UniqueSymbol":
    case "Literal":
    case "String":
    case "Number":
    case "Boolean":
    case "Symbol":
    case "BigInt":
      return [];
    default: {
      // A node the walk does not know could hide a target; fail rather than skip it.
      const unknown: never = ast;
      throw new Error(`rpcThreadTargets walk: unhandled AST node ${JSON.stringify(unknown)}`);
    }
  }
};

const matched = [...WsRpcGroup.requests.values()].flatMap((rpc) => {
  const fields = [...new Set(targetFields(rpc.payloadSchema.ast))];
  return fields.length === 0 ? [] : [{ method: rpc._tag, fields }];
});

const outputMatched = [...WsRpcGroup.requests.values()].flatMap((rpc) => {
  const success = RpcSchema.isStreamSchema(rpc.successSchema)
    ? rpc.successSchema.success
    : rpc.successSchema;
  const fields = [...new Set(targetFields(success.ast))];
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
  expect(matched.find(({ method }) => method === "sandbox.stopById")?.fields).toEqual([
    ".sandboxId",
    ".sandboxId:SandboxId",
  ]);
});

it("runs the access middleware on every RPC the WebSocket serves", () => {
  const unwrapped = [...WsRpcGroup.requests.values()]
    .filter((rpc) => !rpc.middlewares.has(RpcThreadAccess))
    .map((rpc) => rpc._tag);
  expect(unwrapped).toEqual([]);
});

it("names every RPC whose output points at a thread, a machine or a path", () => {
  const unaccounted = outputMatched.filter(
    ({ method }) =>
      !(method in RPC_THREAD_TARGETS) &&
      !(method in RPC_OUTPUT_FILTERED) &&
      !(method in RPC_OUTPUT_EXEMPT),
  );
  expect(unaccounted).toEqual([]);
  // The walk must see through streams, unions, records and the type-only SandboxId brand.
  const fieldsOf = (method: string) => outputMatched.find((match) => match.method === method);
  expect(fieldsOf("subscribeServerConfig")?.fields).toContain(
    ".config.providers[].workspaceSnapshots[].cwd",
  );
  expect(fieldsOf("sandbox.overview")?.fields).toContain(
    ".restoreMode.machines[].sandboxId:SandboxId",
  );
  expect(fieldsOf("subscribeDeviceState")?.fields).toContain(".sessions[].threadId");

  const named = new Set<string>(outputMatched.map(({ method }) => method));
  const listed = [...Object.keys(RPC_OUTPUT_FILTERED), ...Object.keys(RPC_OUTPUT_EXEMPT)];
  expect(listed.filter((method) => !named.has(method))).toEqual([]);
  expect(Object.keys(RPC_OUTPUT_FILTERED).filter((method) => method in RPC_OUTPUT_EXEMPT)).toEqual(
    [],
  );
  expect(Object.keys(RPC_OUTPUT_EXEMPT).filter((method) => method in RPC_THREAD_TARGETS)).toEqual(
    [],
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
