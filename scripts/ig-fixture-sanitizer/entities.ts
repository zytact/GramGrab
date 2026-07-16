import type { EntityKind, FixtureFilename, IdentifierNamespace, PolicyRule } from './policy.ts';
import { FIXTURE_FILENAMES } from './policy.ts';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | Array<JsonValue>;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ActualPath = ReadonlyArray<string | number>;

export interface ClassifiedLeaf {
  readonly filename: FixtureFilename;
  readonly path: ActualPath;
  readonly normalizedPath: string;
  readonly value: JsonPrimitive;
  readonly rule: PolicyRule;
}

export interface EntityReference {
  readonly kind: EntityKind;
  readonly number: number;
}

export interface EntityIndex {
  readonly byRecord: ReadonlyMap<string, EntityReference>;
}

export interface EntityViolation {
  readonly filename: FixtureFilename;
  readonly path: string;
  readonly expected: string;
  readonly observed: string;
  readonly category: 'entity-contradiction';
}

interface Identifier {
  readonly namespace: IdentifierNamespace;
  readonly value: string;
}

interface EntityRecord {
  readonly key: string;
  readonly kind: EntityKind;
  readonly filename: FixtureFilename;
  readonly anchor: ActualPath;
  readonly identifiers: Array<Identifier>;
}

const pathParts = (path: string): ReadonlyArray<string> => path.match(/[^.[\]]+|\[\]/g) ?? [];

export const formatActualPath = (path: ActualPath): string =>
  path.reduce<string>(
    (result, part) =>
      typeof part === 'number'
        ? `${result}[${part}]`
        : result.length === 0
          ? part
          : `${result}.${part}`,
    ''
  );

const anchorFor = (actualPath: ActualPath, normalizedRecordPath: string): ActualPath =>
  actualPath.slice(0, pathParts(normalizedRecordPath).length);

export const entityRecordKey = (
  kind: EntityKind,
  filename: FixtureFilename,
  anchor: ActualPath
): string => `${kind}|${filename}|${formatActualPath(anchor)}`;

const normalizeIdentifier = (value: string | number): string => String(value);

const entityLocation = (
  leaf: ClassifiedLeaf
): { readonly kind: EntityKind; readonly recordPath: string } | undefined => {
  const action = leaf.rule.action;
  if (action.tag === 'entityField') {
    return { kind: action.entity, recordPath: action.recordPath };
  }
  if (action.tag === 'url' && action.entity && action.recordPath) {
    return { kind: action.entity, recordPath: action.recordPath };
  }
  return undefined;
};

class UnionFind {
  readonly #parent = new Map<string, string>();

  add(value: string): void {
    if (!this.#parent.has(value)) this.#parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.#parent.get(value);
    if (!parent || parent === value) return value;
    const root = this.find(parent);
    this.#parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.#parent.set(rightRoot, leftRoot);
  }
}

const recordSortKey = (record: EntityRecord): string => {
  const filenameIndex = FIXTURE_FILENAMES.indexOf(record.filename).toString().padStart(2, '0');
  return `${filenameIndex}|${formatActualPath(record.anchor)}`;
};

const collectRecords = (
  leaves: ReadonlyArray<ClassifiedLeaf>
): ReadonlyMap<string, EntityRecord> => {
  const records = new Map<string, EntityRecord>();
  for (const leaf of leaves) {
    const location = entityLocation(leaf);
    if (!location) continue;
    const anchor = anchorFor(leaf.path, location.recordPath);
    const key = entityRecordKey(location.kind, leaf.filename, anchor);
    let record = records.get(key);
    if (!record) {
      record = {
        key,
        kind: location.kind,
        filename: leaf.filename,
        anchor,
        identifiers: [],
      };
      records.set(key, record);
    }

    const action = leaf.rule.action;
    if (
      action.tag === 'entityField' &&
      action.namespace &&
      (typeof leaf.value === 'string' || typeof leaf.value === 'number') &&
      leaf.value !== ''
    ) {
      record.identifiers.push({
        namespace: action.namespace,
        value: normalizeIdentifier(leaf.value),
      });
    }
  }
  return records;
};

const findContradictions = (
  records: ReadonlyMap<string, EntityRecord>
): ReadonlyArray<EntityViolation> => {
  const violations: Array<EntityViolation> = [];
  for (const record of records.values()) {
    const namespaceValues = new Map<IdentifierNamespace, Set<string>>();
    for (const identifier of record.identifiers) {
      const values = namespaceValues.get(identifier.namespace) ?? new Set<string>();
      values.add(identifier.value);
      namespaceValues.set(identifier.namespace, values);
    }
    for (const [namespace, values] of namespaceValues) {
      if (values.size > 1) {
        violations.push({
          filename: record.filename,
          path: formatActualPath(record.anchor),
          expected: `one ${namespace} identifier per entity record`,
          observed: 'conflicting identifiers',
          category: 'entity-contradiction',
        });
      }
    }
  }
  return violations;
};

const correlateRecords = (records: ReadonlyMap<string, EntityRecord>): UnionFind => {
  const unionFind = new UnionFind();
  const identifiers = new Map<string, string>();
  for (const record of records.values()) {
    unionFind.add(record.key);
    for (const identifier of record.identifiers) {
      const identifierKey = `${record.kind}|${identifier.namespace}|${identifier.value}`;
      const existing = identifiers.get(identifierKey);
      if (existing) unionFind.union(existing, record.key);
      else identifiers.set(identifierKey, record.key);
    }
  }
  return unionFind;
};

const groupComponents = (
  records: ReadonlyMap<string, EntityRecord>,
  unionFind: UnionFind
): ReadonlyMap<EntityKind, ReadonlyMap<string, Array<EntityRecord>>> => {
  const componentsByKind = new Map<EntityKind, Map<string, Array<EntityRecord>>>();
  for (const record of records.values()) {
    const byRoot = componentsByKind.get(record.kind) ?? new Map<string, Array<EntityRecord>>();
    const root = unionFind.find(record.key);
    const component = byRoot.get(root) ?? [];
    component.push(record);
    byRoot.set(root, component);
    componentsByKind.set(record.kind, byRoot);
  }
  return componentsByKind;
};

const numberComponents = (
  componentsByKind: ReadonlyMap<EntityKind, ReadonlyMap<string, Array<EntityRecord>>>
): ReadonlyMap<string, EntityReference> => {
  const byRecord = new Map<string, EntityReference>();
  for (const [kind, byRoot] of componentsByKind) {
    const components = [...byRoot.values()].sort((left, right) => {
      const leftKey = left.map(recordSortKey).sort()[0] ?? '';
      const rightKey = right.map(recordSortKey).sort()[0] ?? '';
      return leftKey.localeCompare(rightKey);
    });
    components.forEach((component, index) => {
      for (const record of component) byRecord.set(record.key, { kind, number: index + 1 });
    });
  }
  return byRecord;
};

export const discoverEntities = (
  leaves: ReadonlyArray<ClassifiedLeaf>
): { readonly index?: EntityIndex; readonly violations: ReadonlyArray<EntityViolation> } => {
  const records = collectRecords(leaves);
  const violations = findContradictions(records);
  if (violations.length > 0) return { violations };
  const components = groupComponents(records, correlateRecords(records));
  return { index: { byRecord: numberComponents(components) }, violations: [] };
};

export const entityForLeaf = (
  leaf: ClassifiedLeaf,
  index: EntityIndex
): EntityReference | undefined => {
  const location = entityLocation(leaf);
  if (!location) return undefined;
  const anchor = anchorFor(leaf.path, location.recordPath);
  return index.byRecord.get(entityRecordKey(location.kind, leaf.filename, anchor));
};
