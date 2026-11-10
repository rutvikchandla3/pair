import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import {
  type GceApi,
  GceApiError,
  type GceImage,
  type GceImageInsert,
  type GceInstance,
  type GceInstanceInsert,
  type GceListOptions,
  type GceMetadataItem,
  type GceOperation,
  type GceSnapshot,
} from "./GceApi.ts";

export type GceMethod =
  | `instances.${keyof GceApi["instances"]}`
  | `disks.${keyof GceApi["disks"]}`
  | `snapshots.${keyof GceApi["snapshots"]}`
  | `images.${keyof GceApi["images"]}`
  | "waitZoneOperation"
  | "waitGlobalOperation";

type OperationMethod =
  | "instances.insert"
  | "instances.start"
  | "instances.stop"
  | "instances.delete"
  | "instances.setMetadata"
  | "instances.setLabels"
  | "disks.createSnapshot"
  | "snapshots.delete"
  | "images.insert"
  | "images.delete";

/** What a stand-in runner keeps on a machine's disk; a snapshot or image copies it. */
export interface FakeGceDisk {
  marker: string | null;
}

export interface FakeGceBoot {
  readonly zone: string;
  readonly name: string;
  readonly metadata: ReadonlyArray<GceMetadataItem>;
  readonly disk: FakeGceDisk;
}

export interface FakeGceCall {
  readonly method: GceMethod;
  readonly zone?: string;
  readonly name?: string;
  readonly body?: unknown;
}

interface FakeInstance {
  readonly zone: string;
  readonly name: string;
  status: string;
  readonly creationTimestamp: string;
  readonly machineType: string;
  labels: Readonly<Record<string, string>>;
  labelFingerprint: string;
  metadata: { readonly fingerprint: string; readonly items: ReadonlyArray<GceMetadataItem> };
  readonly disk: FakeGceDisk;
}

interface FakeImage {
  readonly project: string;
  readonly id: string;
  readonly name: string;
  status: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly family?: string;
  readonly creationTimestamp: string;
  readonly disk: FakeGceDisk;
}

interface FakeSnapshot {
  readonly name: string;
  status: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly disk: FakeGceDisk;
}

interface OperationFailure {
  readonly code: string;
  readonly status: number;
}

interface FakeOperation {
  readonly name: string;
  readonly zone: string | null;
  readonly method: OperationMethod;
  status: "RUNNING" | "DONE";
  error: OperationFailure | null;
  readonly done: Deferred.Deferred<void>;
  readonly finish: Effect.Effect<void>;
}

const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE = /^[a-z0-9_-]{0,63}$/;
const METADATA_VALUE_LIMIT = 256 * 1024;
const LINK_ORIGIN = "https://www.googleapis.com/compute/v1/";
/** The real `wait` answers after up to two minutes; a shorter bound keeps `TestClock` tests short. */
const WAIT_BOUND = "30 seconds";

const pathOf = (reference: string) =>
  reference.replace(/^https:\/\/(www|compute)\.googleapis\.com\/compute\/v1\//, "");

const validLabels = (labels: Readonly<Record<string, string>>) =>
  Object.keys(labels).length <= 64 &&
  Object.entries(labels).every(([key, value]) => LABEL_KEY.test(key) && LABEL_VALUE.test(value));

/** `(labels.k = "v")` and `(labels.k:*)` terms, ANDed; anything else is refused as Google would. */
const parseFilter = (filter: string | undefined) => {
  if (filter === undefined || filter.trim() === "") return () => true;
  const term = /\(\s*labels\.([a-z][a-z0-9_-]*)\s*(?:=\s*"([^"]*)"|:\s*\*)\s*\)/g;
  const terms: Array<{ readonly key: string; readonly value: string | undefined }> = [];
  let rest = filter;
  for (const match of filter.matchAll(term)) {
    terms.push({ key: match[1]!, value: match[2] });
    rest = rest.replace(match[0], "");
  }
  if (rest.trim() !== "") return null;
  return (labels: Readonly<Record<string, string>>) =>
    terms.every(({ key, value }) =>
      value === undefined ? labels[key] !== undefined : labels[key] === value,
    );
};

/**
 * An in-memory Compute Engine. It enforces what the real API enforces and the driver relies on:
 * names, label keys and values, `start` only from `TERMINATED`, `setMetadata` and `setLabels`
 * only with the current fingerprint, and an image only from a stopped instance's disk. Operations
 * finish at once unless a test holds their method.
 */
export const make = Effect.fn("GceApiFake.make")(function* (
  options: {
    readonly project?: string;
    /** Caps every list page, so a test sees paging. */
    readonly pageSize?: number;
    /** Runs, forked in the fake's scope, each time an instance reaches `RUNNING`. */
    readonly onBoot?: (boot: FakeGceBoot) => Effect.Effect<void>;
  } = {},
) {
  const scope = yield* Effect.scope;
  const project = options.project ?? "fake-project";
  const instances = new Map<string, FakeInstance>();
  const images = new Map<string, FakeImage>();
  const snapshots = new Map<string, FakeSnapshot>();
  const operations = new Map<string, FakeOperation>();
  const failures = new Map<GceMethod, Array<GceApiError>>();
  const operationFailures = new Map<OperationMethod, Array<OperationFailure>>();
  const held = new Map<OperationMethod, Array<FakeOperation>>();
  const holding = new Set<OperationMethod>();
  const noCapacity = new Set<string>();
  const calls: Array<FakeGceCall> = [];
  const waits = yield* Queue.unbounded<{
    readonly method: GceMethod;
    readonly operation: string;
  }>();
  let counter = 0;
  const nextId = () => ++counter;

  const instanceKey = (zone: string, name: string) => `${zone}/${name}`;
  const imageKey = (imageProject: string, name: string) => `${imageProject}/${name}`;
  const imageLink = (image: FakeImage) =>
    `${LINK_ORIGIN}projects/${image.project}/global/images/${image.name}`;
  const diskLink = (instance: FakeInstance) =>
    `${LINK_ORIGIN}projects/${project}/zones/${instance.zone}/disks/${instance.name}`;
  const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const refuse = (method: GceMethod, status: number, reason: string) =>
    Effect.fail(new GceApiError({ endpoint: method, failure: "status", status, reason }));

  const call =
    (method: GceMethod, detail: Omit<FakeGceCall, "method"> = {}) =>
    <A>(effect: Effect.Effect<A, GceApiError>): Effect.Effect<A, GceApiError> =>
      Effect.suspend(() => {
        calls.push({ method, ...detail });
        const failure = failures.get(method)?.shift();
        return failure === undefined ? effect : Effect.fail(failure);
      });

  const boot = (instance: FakeInstance) =>
    options.onBoot === undefined
      ? Effect.void
      : options
          .onBoot({
            zone: instance.zone,
            name: instance.name,
            metadata: instance.metadata.items,
            disk: instance.disk,
          })
          .pipe(Effect.forkIn(scope), Effect.asVoid);

  const operationView = (operation: FakeOperation): GceOperation => ({
    name: operation.name,
    status: operation.status,
    ...(operation.error === null
      ? {}
      : {
          httpErrorStatusCode: operation.error.status,
          error: { errors: [{ code: operation.error.code }] },
        }),
  });

  /** `apply` runs when the operation finishes and answers its failure, if any. */
  const operation = Effect.fn("GceApiFake.operation")(function* (
    method: OperationMethod,
    zone: string | null,
    apply: Effect.Effect<OperationFailure | null>,
  ) {
    const injected = operationFailures.get(method)?.shift();
    const done = yield* Deferred.make<void>();
    const op: FakeOperation = {
      name: `operation-${nextId()}`,
      zone,
      method,
      status: "RUNNING",
      error: null,
      done,
      finish: Effect.suspend(() =>
        op.status === "DONE"
          ? Effect.void
          : (injected === undefined ? apply : Effect.succeed(injected)).pipe(
              Effect.flatMap((error) => {
                op.error = error;
                op.status = "DONE";
                return Deferred.succeed(done, undefined);
              }),
            ),
      ),
    };
    operations.set(op.name, op);
    if (holding.has(method)) {
      held.set(method, [...(held.get(method) ?? []), op]);
    } else {
      yield* op.finish;
    }
    // A write answers before its work is done, as the real API's does.
    return { ...operationView(op), status: "RUNNING" } satisfies GceOperation;
  });

  const wait = (method: GceMethod, zone: string | null, name: string) =>
    call(
      method,
      zone === null ? { name } : { zone, name },
    )(
      Effect.gen(function* () {
        const op = operations.get(name);
        if (op === undefined || op.zone !== zone) return yield* refuse(method, 404, "notFound");
        yield* Queue.offer(waits, { method, operation: name });
        if (op.status !== "DONE") yield* Effect.timeoutOption(Deferred.await(op.done), WAIT_BOUND);
        return operationView(op);
      }),
    );

  const instanceView = (instance: FakeInstance): GceInstance => ({
    name: instance.name,
    status: instance.status,
    creationTimestamp: instance.creationTimestamp,
    machineType: instance.machineType,
    labels: { ...instance.labels },
    labelFingerprint: instance.labelFingerprint,
    metadata: { fingerprint: instance.metadata.fingerprint, items: [...instance.metadata.items] },
    disks: [{ source: diskLink(instance), boot: true }],
  });
  const imageView = (image: FakeImage): GceImage => ({
    id: image.id,
    name: image.name,
    status: image.status,
    selfLink: imageLink(image),
    labels: { ...image.labels },
    ...(image.description === undefined ? {} : { description: image.description }),
    ...(image.family === undefined ? {} : { family: image.family }),
    archiveSizeBytes: "1073741824",
    creationTimestamp: image.creationTimestamp,
  });
  const snapshotView = (snapshot: FakeSnapshot): GceSnapshot => ({
    name: snapshot.name,
    status: snapshot.status,
    selfLink: `${LINK_ORIGIN}projects/${project}/global/snapshots/${snapshot.name}`,
    labels: { ...snapshot.labels },
  });

  const page = <A>(items: ReadonlyArray<A>, listOptions: GceListOptions) => {
    const size = Math.min(listOptions.maxResults ?? 500, options.pageSize ?? 500);
    const start = Number(listOptions.pageToken ?? "0");
    const end = start + size;
    return {
      items: items.slice(start, end),
      nextPageToken: end < items.length ? String(end) : null,
    };
  };

  /** Resolves `sourceImage`: a self link, `projects/P/global/images/[family/]X` or `global/images/…`. */
  const findImage = (reference: string) => {
    const match = /^(?:projects\/([^/]+)\/)?global\/images\/(family\/)?([^/]+)$/.exec(
      pathOf(reference),
    );
    if (match === null) return undefined;
    const imageProject = match[1] ?? project;
    if (match[2] === undefined) return images.get(imageKey(imageProject, match[3]!));
    return newestOfFamily(imageProject, match[3]!);
  };
  const newestOfFamily = (imageProject: string, family: string) =>
    Array.from(images.values())
      .filter(
        (image) =>
          image.project === imageProject && image.family === family && image.status === "READY",
      )
      .toSorted(
        (a, b) =>
          b.creationTimestamp.localeCompare(a.creationTimestamp) || Number(b.id) - Number(a.id),
      )
      .at(0);
  const findSnapshot = (reference: string) => {
    const match = /^(?:projects\/[^/]+\/)?global\/snapshots\/([^/]+)$/.exec(pathOf(reference));
    return match === null ? undefined : snapshots.get(match[1]!);
  };

  const validMetadata = (items: ReadonlyArray<GceMetadataItem>) =>
    items.every((item) => (item.value ?? "").length <= METADATA_VALUE_LIMIT) &&
    new Set(items.map((item) => item.key)).size === items.length;

  const capacityFailure = (zone: string): OperationFailure | null =>
    noCapacity.has(zone) ? { code: "ZONE_RESOURCE_POOL_EXHAUSTED", status: 503 } : null;

  const requireInstance = (method: GceMethod, zone: string, name: string) => {
    const instance = instances.get(instanceKey(zone, name));
    return instance === undefined ? refuse(method, 404, "notFound") : Effect.succeed(instance);
  };

  const api: GceApi = {
    instances: {
      insert: (zone, body) =>
        call("instances.insert", { zone, name: body.name, body })(
          Effect.gen(function* () {
            const method = "instances.insert";
            const disk = body.disks[0];
            if (
              !NAME.test(body.name) ||
              !validLabels(body.labels) ||
              body.disks.length !== 1 ||
              disk === undefined ||
              !validLabels(disk.initializeParams.labels) ||
              !body.machineType.startsWith(`zones/${zone}/machineTypes/`) ||
              !validMetadata(body.metadata.items) ||
              (disk.initializeParams.sourceImage === undefined) ===
                (disk.initializeParams.sourceSnapshot === undefined)
            ) {
              return yield* refuse(method, 400, "invalid");
            }
            const source =
              disk.initializeParams.sourceImage === undefined
                ? findSnapshot(disk.initializeParams.sourceSnapshot!)
                : findImage(disk.initializeParams.sourceImage);
            if (source === undefined || source.status !== "READY") {
              return yield* refuse(method, 404, "notFound");
            }
            if (instances.has(instanceKey(zone, body.name))) {
              return yield* refuse(method, 409, "alreadyExists");
            }
            const instance: FakeInstance = {
              zone,
              name: body.name,
              status: "PROVISIONING",
              creationTimestamp: yield* timestamp,
              machineType: body.machineType,
              labels: { ...body.labels },
              labelFingerprint: `fp-${nextId()}`,
              metadata: { fingerprint: `fp-${nextId()}`, items: [...body.metadata.items] },
              disk: { ...source.disk },
            };
            instances.set(instanceKey(zone, body.name), instance);
            return yield* operation(
              method,
              zone,
              Effect.suspend(() => {
                const failure = capacityFailure(zone);
                if (failure !== null) {
                  // A stockout leaves no instance behind.
                  instances.delete(instanceKey(zone, body.name));
                  return Effect.succeed(failure);
                }
                instance.status = "RUNNING";
                return boot(instance).pipe(Effect.as(null));
              }),
            );
          }),
        ),
      get: (zone, name) =>
        call("instances.get", { zone, name })(
          Effect.sync(() => {
            const instance = instances.get(instanceKey(zone, name));
            return instance === undefined ? null : instanceView(instance);
          }),
        ),
      list: (zone, listOptions) =>
        call("instances.list", { zone, body: listOptions })(
          Effect.suspend(() => {
            const matches = parseFilter(listOptions.filter);
            if (matches === null) return refuse("instances.list", 400, "invalid");
            const items = Array.from(instances.values())
              .filter((instance) => instance.zone === zone && matches(instance.labels))
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .map(instanceView);
            return Effect.succeed(page(items, listOptions));
          }),
        ),
      start: (zone, name) =>
        call("instances.start", { zone, name })(
          Effect.gen(function* () {
            const instance = yield* requireInstance("instances.start", zone, name);
            if (instance.status !== "TERMINATED") {
              return yield* refuse("instances.start", 400, "resourceNotReady");
            }
            instance.status = "STAGING";
            return yield* operation(
              "instances.start",
              zone,
              Effect.suspend(() => {
                const failure = capacityFailure(zone);
                if (failure !== null) {
                  instance.status = "TERMINATED";
                  return Effect.succeed(failure);
                }
                instance.status = "RUNNING";
                return boot(instance).pipe(Effect.as(null));
              }),
            );
          }),
        ),
      stop: (zone, name) =>
        call("instances.stop", { zone, name })(
          Effect.gen(function* () {
            const instance = yield* requireInstance("instances.stop", zone, name);
            if (instance.status !== "TERMINATED") instance.status = "STOPPING";
            return yield* operation(
              "instances.stop",
              zone,
              Effect.sync(() => {
                instance.status = "TERMINATED";
                return null;
              }),
            );
          }),
        ),
      delete: (zone, name) =>
        call("instances.delete", { zone, name })(
          Effect.gen(function* () {
            const instance = yield* requireInstance("instances.delete", zone, name);
            instance.status = "STOPPING";
            return yield* operation(
              "instances.delete",
              zone,
              Effect.sync(() => {
                instances.delete(instanceKey(zone, name));
                return null;
              }),
            );
          }),
        ),
      setMetadata: (zone, name, body) =>
        call("instances.setMetadata", { zone, name, body })(
          Effect.gen(function* () {
            const instance = yield* requireInstance("instances.setMetadata", zone, name);
            if (body.fingerprint !== instance.metadata.fingerprint) {
              return yield* refuse("instances.setMetadata", 412, "conditionNotMet");
            }
            if (!validMetadata(body.items)) {
              return yield* refuse("instances.setMetadata", 400, "invalid");
            }
            return yield* operation(
              "instances.setMetadata",
              zone,
              Effect.sync(() => {
                instance.metadata = { fingerprint: `fp-${nextId()}`, items: [...body.items] };
                return null;
              }),
            );
          }),
        ),
      setLabels: (zone, name, body) =>
        call("instances.setLabels", { zone, name, body })(
          Effect.gen(function* () {
            const instance = yield* requireInstance("instances.setLabels", zone, name);
            if (body.labelFingerprint !== instance.labelFingerprint) {
              return yield* refuse("instances.setLabels", 412, "conditionNotMet");
            }
            if (!validLabels(body.labels)) {
              return yield* refuse("instances.setLabels", 400, "invalid");
            }
            return yield* operation(
              "instances.setLabels",
              zone,
              Effect.sync(() => {
                instance.labels = { ...body.labels };
                instance.labelFingerprint = `fp-${nextId()}`;
                return null;
              }),
            );
          }),
        ),
      getGuestAttributes: (zone, name) =>
        call("instances.getGuestAttributes", { zone, name })(
          requireInstance("instances.getGuestAttributes", zone, name).pipe(Effect.as([])),
        ),
      getSerialPortOutput: (zone, name) =>
        call("instances.getSerialPortOutput", { zone, name })(
          requireInstance("instances.getSerialPortOutput", zone, name).pipe(Effect.as("")),
        ),
    },
    disks: {
      createSnapshot: (zone, disk, body) =>
        call("disks.createSnapshot", { zone, name: body.name, body })(
          Effect.gen(function* () {
            const instance = yield* requireInstance("disks.createSnapshot", zone, disk);
            if (!NAME.test(body.name) || !validLabels(body.labels)) {
              return yield* refuse("disks.createSnapshot", 400, "invalid");
            }
            if (snapshots.has(body.name)) {
              return yield* refuse("disks.createSnapshot", 409, "alreadyExists");
            }
            const snapshot: FakeSnapshot = {
              name: body.name,
              status: "CREATING",
              labels: { ...body.labels },
              disk: { ...instance.disk },
            };
            snapshots.set(body.name, snapshot);
            return yield* operation(
              "disks.createSnapshot",
              zone,
              Effect.sync(() => {
                snapshot.status = "READY";
                return null;
              }),
            );
          }),
        ),
    },
    snapshots: {
      get: (name) =>
        call("snapshots.get", { name })(
          Effect.sync(() => {
            const snapshot = snapshots.get(name);
            return snapshot === undefined ? null : snapshotView(snapshot);
          }),
        ),
      delete: (name) =>
        call("snapshots.delete", { name })(
          Effect.gen(function* () {
            if (!snapshots.has(name)) return yield* refuse("snapshots.delete", 404, "notFound");
            return yield* operation(
              "snapshots.delete",
              null,
              Effect.sync(() => {
                snapshots.delete(name);
                return null;
              }),
            );
          }),
        ),
    },
    images: {
      get: (name, imageProject) =>
        call("images.get", { name })(
          Effect.sync(() => {
            const image = images.get(imageKey(imageProject ?? project, name));
            return image === undefined ? null : imageView(image);
          }),
        ),
      getFromFamily: (family, imageProject) =>
        call("images.getFromFamily", { name: family })(
          Effect.sync(() => {
            const image = newestOfFamily(imageProject ?? project, family);
            return image === undefined ? null : imageView(image);
          }),
        ),
      list: (listOptions) =>
        call("images.list", { body: listOptions })(
          Effect.suspend(() => {
            const matches = parseFilter(listOptions.filter);
            if (matches === null) return refuse("images.list", 400, "invalid");
            const items = Array.from(images.values())
              .filter((image) => image.project === project && matches(image.labels))
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .map(imageView);
            return Effect.succeed(page(items, listOptions));
          }),
        ),
      insert: (body: GceImageInsert) =>
        call("images.insert", { name: body.name, body })(
          Effect.gen(function* () {
            if (!NAME.test(body.name) || !NAME.test(body.family) || !validLabels(body.labels)) {
              return yield* refuse("images.insert", 400, "invalid");
            }
            const match = /^(?:projects\/[^/]+\/)?zones\/([^/]+)\/disks\/([^/]+)$/.exec(
              pathOf(body.sourceDisk),
            );
            const instance =
              match === null ? undefined : instances.get(instanceKey(match[1]!, match[2]!));
            if (instance === undefined) return yield* refuse("images.insert", 404, "notFound");
            if (instance.status !== "TERMINATED") {
              return yield* refuse("images.insert", 400, "resourceInUseByAnotherResource");
            }
            if (images.has(imageKey(project, body.name))) {
              return yield* refuse("images.insert", 409, "alreadyExists");
            }
            const image: FakeImage = {
              project,
              id: String(1_000_000 + nextId()),
              name: body.name,
              status: "PENDING",
              labels: { ...body.labels },
              ...(body.description === undefined ? {} : { description: body.description }),
              family: body.family,
              creationTimestamp: yield* timestamp,
              disk: { ...instance.disk },
            };
            images.set(imageKey(project, body.name), image);
            return yield* operation(
              "images.insert",
              null,
              Effect.sync(() => {
                image.status = "READY";
                return null;
              }),
            );
          }),
        ),
      delete: (name) =>
        call("images.delete", { name })(
          Effect.gen(function* () {
            if (!images.has(imageKey(project, name))) {
              return yield* refuse("images.delete", 404, "notFound");
            }
            return yield* operation(
              "images.delete",
              null,
              Effect.sync(() => {
                images.delete(imageKey(project, name));
                return null;
              }),
            );
          }),
        ),
    },
    waitZoneOperation: (zone, name) => wait("waitZoneOperation", zone, name),
    waitGlobalOperation: (name) => wait("waitGlobalOperation", null, name),
  };

  return {
    api,
    project,
    /** Every call in order, with its zone, name and body. */
    calls: calls as ReadonlyArray<FakeGceCall>,
    /** One entry each time a `wait` call starts. */
    waits: waits as Queue.Dequeue<{ readonly method: GceMethod; readonly operation: string }>,
    /** The next call of `method` fails with `error` before doing anything. */
    failNext: (method: GceMethod, error: GceApiError) => {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    /** The next operation of `method` finishes with this error and changes nothing. */
    failNextOperation: (method: OperationMethod, code: string, status = 400) => {
      operationFailures.set(method, [...(operationFailures.get(method) ?? []), { code, status }]);
    },
    /** Operations of `method` stay `RUNNING`, their resource mid-change, until `release`. */
    hold: (method: OperationMethod) => {
      holding.add(method);
    },
    release: Effect.fn("GceApiFake.release")(function* (method: OperationMethod) {
      holding.delete(method);
      const pending = held.get(method) ?? [];
      held.delete(method);
      yield* Effect.forEach(pending, (op) => op.finish, { discard: true });
    }),
    /** Inserts and starts in `zone` finish with `ZONE_RESOURCE_POOL_EXHAUSTED` while false. */
    setCapacity: (zone: string, available: boolean) => {
      if (available) noCapacity.delete(zone);
      else noCapacity.add(zone);
    },
    addImage: Effect.fn("GceApiFake.addImage")(function* (image: {
      readonly name: string;
      readonly project?: string;
      readonly family?: string;
      readonly description?: string;
      readonly labels?: Readonly<Record<string, string>>;
      readonly status?: string;
    }) {
      const added: FakeImage = {
        project: image.project ?? project,
        id: String(1_000_000 + nextId()),
        name: image.name,
        status: image.status ?? "READY",
        labels: image.labels ?? {},
        ...(image.description === undefined ? {} : { description: image.description }),
        ...(image.family === undefined ? {} : { family: image.family }),
        creationTimestamp: yield* timestamp,
        disk: { marker: null },
      };
      images.set(imageKey(added.project, added.name), added);
      return imageView(added);
    }),
    /** Sets a stored image's status, e.g. to hold one at `PENDING`. */
    setImageStatus: (name: string, status: string) => {
      const image = images.get(imageKey(project, name));
      if (image !== undefined) image.status = status;
    },
    instance: (zone: string, name: string) => {
      const instance = instances.get(instanceKey(zone, name));
      return instance === undefined ? null : { ...instanceView(instance), disk: instance.disk };
    },
    instancesNamed: (name: string) =>
      Array.from(instances.values())
        .filter((instance) => instance.name === name)
        .map((instance) => ({ zone: instance.zone, ...instanceView(instance) })),
    snapshot: (name: string) => snapshots.get(name) ?? null,
    image: (name: string) => {
      const image = images.get(imageKey(project, name));
      return image === undefined ? null : imageView(image);
    },
    /** Puts an instance there directly, as another tool would have. */
    putInstance: Effect.fn("GceApiFake.putInstance")(function* (instance: {
      readonly zone: string;
      readonly name: string;
      readonly status?: string;
      readonly labels: Readonly<Record<string, string>>;
    }) {
      instances.set(instanceKey(instance.zone, instance.name), {
        zone: instance.zone,
        name: instance.name,
        status: instance.status ?? "RUNNING",
        creationTimestamp: yield* timestamp,
        machineType: `zones/${instance.zone}/machineTypes/e2-small`,
        labels: instance.labels,
        labelFingerprint: `fp-${nextId()}`,
        metadata: { fingerprint: `fp-${nextId()}`, items: [] },
        disk: { marker: null },
      });
    }),
  };
});

export type GceApiFake = Effect.Success<ReturnType<typeof make>>;

/** The insert bodies the fake received, newest last. */
export const insertBodies = (fake: GceApiFake): ReadonlyArray<GceInstanceInsert> =>
  fake.calls
    .filter((entry) => entry.method === "instances.insert")
    .map((entry) => entry.body as GceInstanceInsert);
