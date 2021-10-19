import assert from "assert";
import {
  Context,
  Log,
  MiniflareError,
  Option,
  OptionType,
  Plugin,
  SetupResult,
  StorageFactory,
} from "@miniflare/shared";
import {
  DurableObjectConstructor,
  DurableObjectFactory,
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectState,
  kInstance,
  kObjectName,
} from "./namespace";
import { DurableObjectStorage } from "./storage";

export type DurableObjectsObjectsOptions = Record<
  string,
  string | { className: string; scriptName?: string }
>;

export interface DurableObjectsOptions {
  durableObjects?: DurableObjectsObjectsOptions;
  durableObjectsPersist?: boolean;
}

interface ProcessedDurableObject {
  name: string;
  className: string;
  scriptName?: string;
}

export type DurableObjectErrorCode = "ERR_CLASS_NOT_FOUND"; // Missing constructor for object

export class DurableObjectError extends MiniflareError<DurableObjectErrorCode> {}

export class DurableObjectsPlugin
  extends Plugin<DurableObjectsOptions>
  implements DurableObjectsOptions
{
  @Option({
    type: OptionType.OBJECT,
    typeFormat: "NAME=CLASS",
    name: "do",
    alias: "o",
    description: "Durable Object to bind",
    fromWrangler: ({ durable_objects }) =>
      durable_objects?.bindings?.reduce(
        (objects, { name, class_name, script_name }) => {
          objects[name] = { className: class_name, scriptName: script_name };
          return objects;
        },
        {} as DurableObjectsObjectsOptions
      ),
  })
  durableObjects?: DurableObjectsObjectsOptions;

  @Option({
    type: OptionType.BOOLEAN_STRING,
    name: "do-persist",
    description: "Persist Durable Object data (to optional path)",
    logName: "Durable Objects Persistence",
    fromWrangler: ({ miniflare }) => miniflare?.durable_objects_persist,
  })
  durableObjectsPersist?: boolean;

  readonly #processedObjects: ProcessedDurableObject[];

  #contextPromise: Promise<void>;
  #contextResolve?: () => void;
  #constructors = new Map<string, DurableObjectConstructor>();
  #bindings: Context = {};

  readonly #objects = new Map<string, Promise<DurableObjectState>>();

  constructor(log: Log, options?: DurableObjectsOptions) {
    super(log);
    this.assignOptions(options);

    this.#processedObjects = Object.entries(this.durableObjects ?? {}).map(
      ([name, options]) => {
        const className =
          typeof options === "object" ? options.className : options;
        const scriptName =
          typeof options === "object" ? options.scriptName : undefined;
        if (scriptName !== undefined) {
          throw new Error("Durable Object scriptName is not yet supported");
        }
        return { name, className, scriptName };
      }
    );

    this.#contextPromise = new Promise(
      (resolve) => (this.#contextResolve = resolve)
    );
  }

  async getObject(
    storage: StorageFactory,
    id: DurableObjectId
  ): Promise<DurableObjectState> {
    // Wait for constructors and bindings
    await this.#contextPromise;

    // Reuse existing instances
    const objectName = id[kObjectName];
    // Put each object in its own namespace/directory
    const key = `${objectName}:${id.toString()}`;
    let statePromise = this.#objects.get(key);
    if (statePromise) return statePromise;

    // We store Promise<DurableObjectState> for map values instead of
    // DurableObjectState as we only ever want to create one
    // DurableObjectStorage for a Durable Object, and getting storage is an
    // asynchronous operation. The alternative would be to make this a critical
    // section protected with a mutex.
    statePromise = (async () => {
      const objectStorage = new DurableObjectStorage(
        await storage.storage(key, this.durableObjectsPersist)
      );
      const state = new DurableObjectState(id, objectStorage);

      // Create and store new instance if none found
      const constructor = this.#constructors.get(objectName);
      // Should've thrown error earlier in reload if class not found
      assert(constructor);

      state[kInstance] = new constructor(state, this.#bindings);
      return state;
    })();
    this.#objects.set(key, statePromise);
    return statePromise;
  }

  getNamespace(
    storage: StorageFactory,
    objectName: string
  ): DurableObjectNamespace {
    const factory: DurableObjectFactory = (id) => this.getObject(storage, id);
    return new DurableObjectNamespace(objectName, factory);
  }

  setup(storageFactory: StorageFactory): SetupResult {
    const bindings: Context = {};
    const watch: string[] = [];
    for (const { name } of this.#processedObjects) {
      // TODO: get namespace from scriptName instance, maybe watch it?
      bindings[name] = this.getNamespace(storageFactory, name);
    }
    return { bindings, watch };
  }

  beforeReload(): void {
    // Clear instance map, this should cause old instances to be GCed
    this.#objects.clear();
    this.#contextPromise = new Promise(
      (resolve) => (this.#contextResolve = resolve)
    );
  }

  reload(moduleExports: Context, bindings: Context): void {
    this.#constructors.clear();
    for (const { name, className, scriptName } of this.#processedObjects) {
      if (scriptName !== undefined) continue;
      const constructor = moduleExports[className];
      if (constructor) {
        this.#constructors.set(name, constructor);
      } else {
        throw new DurableObjectError(
          "ERR_CLASS_NOT_FOUND",
          `Class ${className} for Durable Object ${name} not found`
        );
      }
    }
    this.#bindings = bindings;
    this.#contextResolve?.();
  }

  dispose(): void {
    return this.beforeReload();
  }
}